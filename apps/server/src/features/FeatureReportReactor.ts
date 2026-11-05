import {
  CommandId,
  idleCompactionOf,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import { FeatureService } from "./FeatureService.ts";

const REPORTED_STATUSES = new Set(["completed", "failed"]);
const OPEN_TASK_STATUSES = new Set(["pending", "running", "waiting"]);
const UNDELIVERED_RESULT_STATES = new Set(["pending", "claimed"]);
const MAX_REPORT_CHARS = 8_000;
/** Requests that wait on the person; auth refreshes and tool calls resolve without them. */
const ASKING_KINDS = new Set<string>([
  "user_input",
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);

/**
 * Tells the thread that started a feature what its lead said each time the lead stops with no
 * crew task still open, so a bot's headquarters can relay the plan to approve or the result.
 */
export class FeatureReportReactor extends Context.Service<
  FeatureReportReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly catchUp: () => Effect.Effect<void>;
  }
>()("t3/features/FeatureReportReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const features = yield* FeatureService;

  /** The feature `threadId` leads, or null when it isn't a feature's lead. */
  const featureLedBy = Effect.fnUntraced(function* (threadId: ThreadId) {
    const lead = yield* projections.getThread(threadId);
    const feature = lead.feature;
    // Subagents, forks and side chats of the lead carry the feature too; only the lead reports.
    if (!feature || feature.member !== undefined || lead.lineage.parentThreadId !== null) {
      return null;
    }
    return feature;
  });

  /** `threadId` when it is another live thread than the lead's. */
  const reachable = Effect.fnUntraced(function* (
    threadId: ThreadId | null,
    leadThreadId: ThreadId,
  ) {
    if (threadId === null || threadId === leadThreadId) return null;
    const thread = yield* projections.getThread(threadId);
    return thread.archivedAt !== null || thread.deletedAt !== null ? null : threadId;
  });

  /** The feature `threadId` leads and the thread that started it, or null with none to tell. */
  const requesterOf = Effect.fnUntraced(function* (threadId: ThreadId) {
    const feature = yield* featureLedBy(threadId);
    if (feature === null) return null;
    const requesterId = yield* reachable(yield* features.requesterThreadId(feature.id), threadId);
    return requesterId === null ? null : { feature, requesterId };
  });

  /**
   * Who hears that the lead waits: the thread that started the feature, else a child's parent
   * lead, which can answer it. A child reports its stops to its parent another way.
   */
  const askedOf = Effect.fnUntraced(function* (threadId: ThreadId) {
    const requester = yield* requesterOf(threadId);
    if (requester !== null) return requester;
    const feature = yield* featureLedBy(threadId);
    if (feature === null) return null;
    const parentLead = yield* reachable(yield* features.parentLeadThreadId(feature.id), threadId);
    return parentLead === null ? null : { feature, requesterId: parentLead };
  });

  /** How a report names the feature, with the project request it answers. */
  const featureLabel = Effect.fnUntraced(function* (
    feature: { readonly id: string; readonly title: string },
    leadThreadId: ThreadId,
  ) {
    const requestId = yield* features.requestIdOf(feature.id);
    return `Feature "${feature.title}" (lead thread ${leadThreadId}${requestId === null ? "" : `, request ${requestId}`})`;
  });

  const reportKey = (key: string) => ({
    commandId: CommandId.make(`server:feature-report:${key}`),
    messageId: MessageId.make(`message:feature-report:${key}`),
  });

  const post = (input: {
    readonly key: string;
    readonly requesterId: ThreadId;
    readonly leadThreadId: ThreadId;
    readonly text: string;
    readonly failed: boolean;
    readonly summary: string;
  }) =>
    engine.dispatch({
      type: "message.dispatch",
      ...reportKey(input.key),
      threadId: input.requesterId,
      text: input.text,
      notification: {
        source: { kind: "subagent", childThreadId: input.leadThreadId },
        outcome: input.failed ? "failed" : "updated",
        summary: input.summary,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });

  /** Tells the requester the lead waits on the person; `request` is pending on `threadId`. */
  const reportRequest = Effect.fnUntraced(function* (
    threadId: ThreadId,
    request: OrchestrationV2RuntimeRequest,
  ) {
    if (request.status !== "pending" || !ASKING_KINDS.has(request.kind)) return;
    if (request.owner !== undefined) return;
    const target = yield* askedOf(threadId);
    if (target === null) return;
    const asks = request.kind === "user_input" ? "a question" : "an approval";
    yield* post({
      key: `request:${request.id}`,
      requesterId: target.requesterId,
      leadThreadId: threadId,
      text: `${yield* featureLabel(target.feature, threadId)} is waiting on the person: ${asks} in its lead's thread.`,
      failed: false,
      summary: `Feature "${target.feature.title}" is waiting on you`,
    });
  });

  /** Tells the requester what the lead said when `run` stopped, unless its crew still works. */
  const reportRun = Effect.fnUntraced(function* (run: OrchestrationV2Run) {
    if (!REPORTED_STATUSES.has(run.status)) return;
    const target = yield* requesterOf(run.threadId);
    if (target === null) return;
    const lead = yield* projections.getThreadRecords(run.threadId, ["subagents", "messages"], {
      messageRunIds: [run.id],
    });
    // A silent /compact run is upkeep, not something the lead said.
    const prompt = lead.messages.find((message) => message.id === run.userMessageId);
    if (prompt !== undefined && idleCompactionOf(prompt) !== undefined) return;
    // The crew's result wakes the lead again; it reports once that turn stops.
    if (
      lead.subagents.some(
        (task) =>
          OPEN_TASK_STATUSES.has(task.status) ||
          UNDELIVERED_RESULT_STATES.has(task.completionDelivery?.state ?? ""),
      )
    ) {
      return;
    }
    const said =
      lead.messages
        .findLast((message) => message.role === "assistant" && !message.streaming)
        ?.text.trim() ?? "";
    const text =
      said.length > MAX_REPORT_CHARS
        ? `${said.slice(0, MAX_REPORT_CHARS)}… (read the rest in the lead's thread)`
        : said || "(no message)";
    yield* post({
      key: run.id,
      requesterId: target.requesterId,
      leadThreadId: run.threadId,
      text: `${yield* featureLabel(target.feature, run.threadId)} [${run.status}]:\n${text}`,
      failed: run.status === "failed",
      summary: `Feature "${target.feature.title}" reported back`,
    });
  });

  // Runs for every domain event; most return before reading anything.
  const handle: FeatureReportReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      // A lead waiting on the person won't stop until they answer, so say so now.
      if (event.type === "runtime-request.updated") {
        yield* reportRequest(event.threadId, event.payload);
      } else if (event.type === "run.updated") {
        yield* reportRun(event.payload);
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("reporting a feature lead's stop failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  /**
   * Reports a lead's latest stop and pending requests that no event reached, such as one that
   * committed just before a restart. A report already in the requester's thread is skipped.
   */
  const catchUp: FeatureReportReactor["Service"]["catchUp"] = Effect.fnUntraced(
    function* () {
      const unreported = Effect.fnUntraced(function* (target: ThreadId, key: string) {
        const { messageId } = reportKey(key);
        const { messages } = yield* projections.getThreadRecords(target, ["messages"], {
          messageIds: [messageId],
        });
        return messages.length === 0;
      });
      for (const leadThreadId of yield* features.reportingLeads) {
        const asked = yield* askedOf(leadThreadId);
        if (asked === null) continue;
        const requester = yield* requesterOf(leadThreadId);
        const lead = yield* projections.getThreadRecords(
          leadThreadId,
          ["runs", "runtimeRequests"],
          { runStatuses: [], includeLatestRun: true, runtimeRequestStatuses: ["pending"] },
        );
        if (requester !== null) {
          for (const run of lead.runs) {
            if (
              REPORTED_STATUSES.has(run.status) &&
              (yield* unreported(requester.requesterId, run.id))
            ) {
              yield* reportRun(run);
            }
          }
        }
        for (const request of lead.runtimeRequests) {
          if (yield* unreported(asked.requesterId, `request:${request.id}`)) {
            yield* reportRequest(leadThreadId, request);
          }
        }
      }
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("catching up feature reports failed", { cause }),
    ),
  );

  // Catch-up covers stops that committed before the stream subscribed; a repeat is one command.
  const start: FeatureReportReactor["Service"]["start"] = Effect.fn("FeatureReportReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, handle).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("feature report event stream failed", { cause }),
          ),
        ),
      );
      yield* forkParked(catchUp());
    },
  );

  return { start, handle, catchUp } satisfies FeatureReportReactor["Service"];
});

export const layer = Layer.effect(FeatureReportReactor, make);
