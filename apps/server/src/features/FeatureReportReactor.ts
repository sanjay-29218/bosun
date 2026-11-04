import { CommandId, MessageId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
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

  // Runs for every domain event; most return before reading anything.
  const handle: FeatureReportReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated" || !REPORTED_STATUSES.has(event.payload.status)) return;
      const run = event.payload;
      const lead = yield* projections.getThreadRecords(run.threadId, ["subagents", "messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [run.id],
      });
      const feature = lead.thread.feature;
      if (!feature || feature.member !== undefined) return;
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
      const requesterId = yield* features.requesterThreadId(feature.id);
      if (requesterId === null || requesterId === lead.thread.id) return;
      const requester = yield* projections.getThread(requesterId);
      if (requester.archivedAt !== null || requester.deletedAt !== null) return;
      const said = lead.messages.findLast((message) => !message.streaming)?.text.trim() ?? "";
      const text =
        said.length > MAX_REPORT_CHARS
          ? `${said.slice(0, MAX_REPORT_CHARS)}… (read the rest in the lead's thread)`
          : said || "(no message)";
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:feature-report:${run.id}`),
        threadId: requesterId,
        messageId: MessageId.make(`message:feature-report:${run.id}`),
        text: `Feature "${feature.title}" (lead thread ${lead.thread.id}) [${run.status}]:\n${text}`,
        notification: {
          source: { kind: "subagent", childThreadId: lead.thread.id },
          outcome: run.status === "failed" ? "failed" : "updated",
          summary: `Feature "${feature.title}" reported back`,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
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
