import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
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
  }
>()("t3/features/FeatureReportReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const features = yield* FeatureService;

  /** The feature `threadId` leads and the thread to tell, or null when there's none to tell. */
  const requesterOf = Effect.fnUntraced(function* (threadId: ThreadId) {
    const lead = yield* projections.getThread(threadId);
    const feature = lead.feature;
    // A lead's and its crew's own subagents carry the feature too; only the lead reports.
    if (
      !feature ||
      feature.member !== undefined ||
      lead.lineage.relationshipToParent === "subagent"
    ) {
      return null;
    }
    const requesterId = yield* features.requesterThreadId(feature.id);
    if (requesterId === null || requesterId === lead.id) return null;
    const requester = yield* projections.getThread(requesterId);
    if (requester.archivedAt !== null || requester.deletedAt !== null) return null;
    return { feature, requesterId };
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
      commandId: CommandId.make(`server:feature-report:${input.key}`),
      threadId: input.requesterId,
      messageId: MessageId.make(`message:feature-report:${input.key}`),
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

  // Runs for every domain event; most return before reading anything.
  const handle: FeatureReportReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      // A lead waiting on the person won't stop until they answer, so say so now.
      if (event.type === "runtime-request.updated") {
        const request = event.payload;
        if (request.status !== "pending" || !ASKING_KINDS.has(request.kind)) return;
        if (request.owner !== undefined) return;
        const target = yield* requesterOf(event.threadId);
        if (target === null) return;
        const asks = request.kind === "user_input" ? "a question" : "an approval";
        yield* post({
          key: `request:${request.id}`,
          requesterId: target.requesterId,
          leadThreadId: event.threadId,
          text: `Feature "${target.feature.title}" (lead thread ${event.threadId}) is waiting on the person: ${asks} in its lead's thread.`,
          failed: false,
          summary: `Feature "${target.feature.title}" is waiting on you`,
        });
        return;
      }
      if (event.type !== "run.updated" || !REPORTED_STATUSES.has(event.payload.status)) return;
      const run = event.payload;
      const target = yield* requesterOf(run.threadId);
      if (target === null) return;
      const lead = yield* projections.getThreadRecords(run.threadId, ["subagents", "messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [run.id],
      });
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
      const said = lead.messages.findLast((message) => !message.streaming)?.text.trim() ?? "";
      const text =
        said.length > MAX_REPORT_CHARS
          ? `${said.slice(0, MAX_REPORT_CHARS)}… (read the rest in the lead's thread)`
          : said || "(no message)";
      yield* post({
        key: run.id,
        requesterId: target.requesterId,
        leadThreadId: run.threadId,
        text: `Feature "${target.feature.title}" (lead thread ${run.threadId}) [${run.status}]:\n${text}`,
        failed: run.status === "failed",
        summary: `Feature "${target.feature.title}" reported back`,
      });
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

  const start: FeatureReportReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("feature report event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies FeatureReportReactor["Service"];
});

export const layer = Layer.effect(FeatureReportReactor, make);
