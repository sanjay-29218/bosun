import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as FeatureReportReactor from "./FeatureReportReactor.ts";
import { FeatureService } from "./FeatureService.ts";

const leadThreadId = ThreadId.make("thread:lead");
const headquartersId = ThreadId.make("bot-run:bot-hq:bot-captain");

const runUpdated = (status: string, threadId = leadThreadId) =>
  ({
    type: "run.updated",
    threadId,
    payload: { id: RunId.make(`run:${threadId}:1`), threadId, status },
  }) as unknown as OrchestrationV2DomainEvent;

const requestUpdated = (status: string, kind = "user_input") =>
  ({
    type: "runtime-request.updated",
    threadId: leadThreadId,
    payload: { id: "request:plan", status, kind },
  }) as unknown as OrchestrationV2DomainEvent;

const setup = (input: {
  readonly member?: string;
  readonly subagent?: boolean;
  readonly openTask?: boolean;
  readonly requester?: ThreadId | null;
}) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const layer = FeatureReportReactor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            dispatch: (command) =>
              Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({} as never)),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: () =>
              Effect.succeed({
                subagents: input.openTask ? [{ status: "running" }] : [{ status: "completed" }],
                messages: [{ text: "The plan is ready. Approve it?", streaming: false }],
              } as never),
            getThread: (threadId) =>
              Effect.succeed(
                (threadId === leadThreadId
                  ? {
                      id: leadThreadId,
                      lineage: { relationshipToParent: input.subagent ? "subagent" : null },
                      feature: {
                        id: "feature:dark",
                        title: "Dark mode",
                        ...(input.member ? { member: input.member } : {}),
                      },
                    }
                  : { id: threadId, archivedAt: null, deletedAt: null }) as never,
              ),
          }),
          Layer.mock(FeatureService)({
            requesterThreadId: () =>
              Effect.succeed(input.requester === undefined ? headquartersId : input.requester),
          }),
        ),
      ),
    );
    const reactor = yield* FeatureReportReactor.FeatureReportReactor.pipe(Effect.provide(layer));
    return { reactor, dispatched };
  });

it.effect("tells the thread that started a feature what its lead said when it stops", () =>
  Effect.gen(function* () {
    const { reactor, dispatched } = yield* setup({});
    yield* reactor.handle(runUpdated("completed"));
    const [report] = yield* Ref.get(dispatched);
    assert.equal(report?.type, "message.dispatch");
    if (report?.type !== "message.dispatch") return;
    assert.equal(report.threadId, headquartersId);
    assert.include(report.text, 'Feature "Dark mode"');
    assert.include(report.text, "The plan is ready. Approve it?");
    // One report per lead run, however often the run is updated.
    assert.equal(report.commandId, `server:feature-report:run:${leadThreadId}:1`);
  }),
);

it.effect("stays quiet while the crew works, for crew threads, and with no one to tell", () =>
  Effect.gen(function* () {
    for (const [input, status] of [
      [{ openTask: true }, "completed"],
      [{ member: "Builder" }, "completed"],
      // A lead's or crew member's own subagent carries the feature but isn't its lead.
      [{ subagent: true }, "completed"],
      [{ requester: null }, "completed"],
      [{}, "running"],
      [{}, "interrupted"],
    ] as const) {
      const { reactor, dispatched } = yield* setup(input);
      yield* reactor.handle(runUpdated(status));
      assert.deepEqual(yield* Ref.get(dispatched), [], JSON.stringify({ input, status }));
    }
  }),
);

it.effect("tells the thread that started a feature when its lead waits on the person", () =>
  Effect.gen(function* () {
    const { reactor, dispatched } = yield* setup({});
    yield* reactor.handle(requestUpdated("pending"));
    yield* reactor.handle(requestUpdated("resolved"));
    yield* reactor.handle(requestUpdated("pending", "auth_refresh"));
    const reports = yield* Ref.get(dispatched);
    assert.lengthOf(reports, 1);
    const [report] = reports;
    if (report?.type !== "message.dispatch") return assert.fail("expected a message");
    assert.equal(report.threadId, headquartersId);
    assert.include(report.text, "waiting on the person: a question");
    assert.equal(report.commandId, "server:feature-report:request:request:plan");
  }),
);
