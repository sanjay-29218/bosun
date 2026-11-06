import {
  MessageId,
  type OrchestrationV2DomainEvent,
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
import { FeatureService, featureReportLabel } from "./FeatureService.ts";
import { NoticeInbox } from "./NoticeInbox.ts";

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
 * Tells the thread that started a feature, or a child's parent lead, when the lead waits on the
 * person. Its stage-end reports come from `FeatureService`.
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
  const inbox = yield* NoticeInbox;

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
    // A thread that is gone has no one to tell.
    const thread = yield* projections.getThread(threadId).pipe(Effect.orElseSucceed(() => null));
    return thread === null || thread.archivedAt !== null || thread.deletedAt !== null
      ? null
      : threadId;
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
    return featureReportLabel(feature.title, leadThreadId, yield* features.requestIdOf(feature.id));
  });

  const reportKey = (key: string) => `feature-report:${key}`;

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
    yield* inbox.post({
      threadId: target.requesterId,
      key: reportKey(`request:${request.id}`),
      subject: target.feature.id,
      requestId: request.id,
      text: `${yield* featureLabel(target.feature, threadId)} is waiting on the person: ${asks} in its lead's thread.`,
      notification: {
        childThreadId: threadId,
        outcome: "updated",
        summary: `Feature "${target.feature.title}" is waiting on you`,
      },
    });
  });

  // Runs for every domain event; most return before reading anything.
  const handle: FeatureReportReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      // A lead waiting on the person won't stop until they answer, so say so now.
      if (event.type === "runtime-request.updated") {
        yield* reportRequest(event.threadId, event.payload);
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("reporting a feature lead's question failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  /**
   * Reports pending requests that no event reached, such as one that committed just before a
   * restart. One reported before the inbox existed is skipped; the inbox skips the rest.
   */
  const catchUp: FeatureReportReactor["Service"]["catchUp"] = Effect.fnUntraced(
    function* () {
      const catchUpLead = Effect.fnUntraced(
        function* (leadThreadId: ThreadId) {
          const asked = yield* askedOf(leadThreadId);
          if (asked === null) return;
          const lead = yield* projections.getThreadRecords(leadThreadId, ["runtimeRequests"], {
            runtimeRequestStatuses: ["pending"],
          });
          for (const request of lead.runtimeRequests) {
            const { messages } = yield* projections.getThreadRecords(
              asked.requesterId,
              ["messages"],
              { messageIds: [MessageId.make(`message:${reportKey(`request:${request.id}`)}`)] },
            );
            if (messages.length === 0) yield* reportRequest(leadThreadId, request);
          }
        },
        // One lead failing to check doesn't keep the others from theirs.
        (effect, leadThreadId) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("catching up a feature lead's questions failed", {
                leadThreadId,
                cause,
              }),
            ),
          ),
      );
      const leads = yield* features.reportingLeads;
      yield* inbox.holding(Effect.forEach(leads, catchUpLead, { discard: true }));
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("catching up feature reports failed", { cause }),
    ),
  );

  // Catch-up covers requests that committed before the stream subscribed.
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
