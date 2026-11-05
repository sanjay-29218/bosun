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

const run = (status: string, threadId = leadThreadId) => ({
  id: RunId.make(`run:${threadId}:1`),
  threadId,
  status,
  userMessageId: "message:prompt",
});
const runUpdated = (status: string, threadId = leadThreadId) =>
  ({
    type: "run.updated",
    threadId,
    payload: run(status, threadId),
  }) as unknown as OrchestrationV2DomainEvent;

const requestUpdated = (status: string, kind = "user_input") =>
  ({
    type: "runtime-request.updated",
    threadId: leadThreadId,
    payload: { id: "request:plan", status, kind },
  }) as unknown as OrchestrationV2DomainEvent;

const setup = (input: {
  readonly member?: string;
  /** How the thread with the feature tag relates to a parent; the lead has none. */
  readonly parent?: "subagent" | "fork" | "sideChat";
  readonly openTask?: boolean;
  /** The run was a silent idle /compact. */
  readonly compaction?: boolean;
  readonly requester?: ThreadId | null;
  /** Message ids already in the requester's thread. */
  readonly reported?: ReadonlyArray<string>;
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
            getThreadRecords: (threadId, _fields, filter) =>
              Effect.succeed(
                (threadId === headquartersId
                  ? {
                      messages: (filter?.messageIds ?? []).flatMap((id) =>
                        input.reported?.includes(id) ? [{ id }] : [],
                      ),
                    }
                  : {
                      subagents: input.openTask
                        ? [{ status: "running" }]
                        : [{ status: "completed" }],
                      runs: [run("completed")],
                      runtimeRequests: [
                        { id: "request:plan", status: "pending", kind: "user_input" },
                      ],
                      messages: [
                        {
                          id: "message:prompt",
                          role: "user",
                          text: input.compaction ? "/compact" : "Plan dark mode",
                          ...(input.compaction ? { idleCompaction: "beforeCacheExpires" } : {}),
                        },
                        {
                          role: "assistant",
                          text: "The plan is ready. Approve it?",
                          streaming: false,
                        },
                      ],
                    }) as never,
              ),
            getThread: (threadId) =>
              Effect.succeed(
                (threadId === leadThreadId
                  ? {
                      id: leadThreadId,
                      lineage:
                        input.parent === undefined
                          ? { parentThreadId: null, relationshipToParent: null }
                          : {
                              parentThreadId: ThreadId.make("thread:other"),
                              relationshipToParent:
                                input.parent === "subagent" ? "subagent" : "fork",
                              ...(input.parent === "sideChat" ? { sideChat: true } : {}),
                            },
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
            reportingLeads: Effect.succeed([leadThreadId]),
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
      // A lead's own subagent, a fork of it and a side chat carry the feature but don't lead it.
      [{ parent: "subagent" }, "completed"],
      [{ parent: "fork" }, "completed"],
      [{ parent: "sideChat" }, "completed"],
      // An idle /compact is upkeep, not something the lead said.
      [{ compaction: true }, "completed"],
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

it.effect("catches up on stops no event reported, such as one before a restart", () =>
  Effect.gen(function* () {
    const fresh = yield* setup({});
    yield* fresh.reactor.catchUp();
    assert.deepEqual(
      (yield* Ref.get(fresh.dispatched)).map((command) => command.commandId),
      [`server:feature-report:run:${leadThreadId}:1`, "server:feature-report:request:request:plan"],
    );
    const reported = yield* setup({
      reported: [
        `message:feature-report:run:${leadThreadId}:1`,
        "message:feature-report:request:request:plan",
      ],
    });
    yield* reported.reactor.catchUp();
    assert.deepEqual(yield* Ref.get(reported.dispatched), []);
  }),
);
