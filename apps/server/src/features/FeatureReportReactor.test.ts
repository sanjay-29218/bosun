import { assert, it } from "@effect/vitest";
import { type OrchestrationV2DomainEvent, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as FeatureReportReactor from "./FeatureReportReactor.ts";
import { FeatureService } from "./FeatureService.ts";
import { type Notice, NoticeInbox } from "./NoticeInbox.ts";

const leadThreadId = ThreadId.make("thread:lead");
const headquartersId = ThreadId.make("bot-run:bot-hq:bot-captain");
const parentLeadId = ThreadId.make("thread:epic-lead");
const brokenLeadId = ThreadId.make("thread:broken-lead");

const runUpdated = (status: string) =>
  ({
    type: "run.updated",
    threadId: leadThreadId,
    payload: { id: RunId.make("run:lead:1"), threadId: leadThreadId, status },
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
  readonly requester?: ThreadId | null;
  /** The lead of the feature this one is a child of. */
  readonly parentLead?: ThreadId | null;
  /** The project request the feature answers. */
  readonly requestId?: string;
  /** Message ids already in the requester's thread. */
  readonly reported?: ReadonlyArray<string>;
  /** A lead ahead of this one in catch-up whose thread can't be read. */
  readonly brokenLead?: boolean;
}) =>
  Effect.gen(function* () {
    const posted = yield* Ref.make<ReadonlyArray<Notice>>([]);
    const layer = FeatureReportReactor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          Layer.mock(NoticeInbox)({
            post: (notice) => Ref.update(posted, (all) => [...all, notice]),
            holding: (effect) => effect,
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
                      runtimeRequests: [
                        { id: "request:plan", status: "pending", kind: "user_input" },
                      ],
                    }) as never,
              ),
            getThread: (threadId) =>
              threadId === brokenLeadId
                ? Effect.die("thread not found")
                : Effect.succeed(
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
            parentLeadThreadId: () => Effect.succeed(input.parentLead ?? null),
            requestIdOf: () => Effect.succeed(input.requestId ?? null),
            reportingLeads: Effect.succeed(
              input.brokenLead ? [brokenLeadId, leadThreadId] : [leadThreadId],
            ),
          }),
        ),
      ),
    );
    const reactor = yield* FeatureReportReactor.FeatureReportReactor.pipe(Effect.provide(layer));
    return { reactor, posted };
  });

it.effect("tells the thread that started a feature when its lead waits on the person", () =>
  Effect.gen(function* () {
    const { reactor, posted } = yield* setup({ requestId: "R-7" });
    yield* reactor.handle(requestUpdated("pending"));
    yield* reactor.handle(requestUpdated("resolved"));
    yield* reactor.handle(requestUpdated("pending", "auth_refresh"));
    // Its stops are reported by the feature service, at a stage's end.
    yield* reactor.handle(runUpdated("completed"));
    const notices = yield* Ref.get(posted);
    assert.lengthOf(notices, 1);
    const [notice] = notices;
    assert.equal(notice?.threadId, headquartersId);
    assert.equal(notice?.key, "feature-report:request:request:plan");
    assert.equal(notice?.requestId, "request:plan");
    assert.equal(notice?.subject, "feature:dark");
    assert.include(
      notice?.text,
      `Feature "Dark mode" (lead thread ${leadThreadId}, request R-7) is waiting on the person: a question`,
    );
  }),
);

it.effect("stays quiet for crew threads and with no one to tell", () =>
  Effect.gen(function* () {
    for (const input of [
      { member: "Builder" },
      // A lead's own subagent, a fork of it and a side chat carry the feature but don't lead it.
      { parent: "subagent" },
      { parent: "fork" },
      { parent: "sideChat" },
      { requester: null },
    ] as const) {
      const { reactor, posted } = yield* setup(input);
      yield* reactor.handle(requestUpdated("pending"));
      assert.deepEqual(yield* Ref.get(posted), [], JSON.stringify(input));
    }
  }),
);

it.effect("tells an Epic child's parent lead when the child's lead waits", () =>
  Effect.gen(function* () {
    const { reactor, posted } = yield* setup({ requester: null, parentLead: parentLeadId });
    yield* reactor.handle(requestUpdated("pending"));
    const [notice, ...rest] = yield* Ref.get(posted);
    assert.deepEqual(rest, []);
    assert.equal(notice?.threadId, parentLeadId);
    assert.include(notice?.text, "waiting on the person: a question");
  }),
);

it.effect("catches up on questions no event reported, such as one before a restart", () =>
  Effect.gen(function* () {
    const fresh = yield* setup({});
    yield* fresh.reactor.catchUp();
    assert.deepEqual(
      (yield* Ref.get(fresh.posted)).map((notice) => notice.key),
      ["feature-report:request:request:plan"],
    );
    // A lead that fails to check doesn't keep the next from its catch-up.
    const broken = yield* setup({ brokenLead: true });
    yield* broken.reactor.catchUp();
    assert.lengthOf(yield* Ref.get(broken.posted), 1);
    // One the reactor sent before the inbox existed isn't sent again.
    const reported = yield* setup({ reported: ["message:feature-report:request:request:plan"] });
    yield* reported.reactor.catchUp();
    assert.deepEqual(yield* Ref.get(reported.posted), []);
  }),
);
