import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type WorkflowFeatureSnapshot,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { FeatureService } from "../../../features/FeatureService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { makeStarterWorkflow } from "../../../workflows/starterWorkflow.ts";
import * as FeaturesHandlers from "./handlers.ts";
import { FeaturesToolkit } from "./tools.ts";

const caller = ThreadId.make("thread:caller");
const projectId = liveThreadShell(caller).projectId;
const snapshot: WorkflowFeatureSnapshot = {
  featureId: "feature",
  projectId,
  definition: makeStarterWorkflow(),
  eventVersion: 0,
  createdAt: "2026-10-09T00:00:00Z",
  steps: [],
  activeStepId: null,
  readyStepIds: [],
  executionCount: 0,
  completed: false,
  cancelled: false,
  historyLength: 0,
  recentEvents: [],
};

const run = (
  tool: "t3_feature_attach_thread" | "t3_feature_detach_thread",
  params: Record<string, unknown>,
  threadId: ThreadId = caller,
  capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["orchestration"]),
) => {
  const calls: Array<Record<string, unknown>> = [];
  return Effect.gen(function* () {
    const toolkit = yield* FeaturesToolkit;
    const results = yield* toolkit
      .handle(tool, params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return { result: results.at(-1)?.result, calls };
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(FeaturesHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:features"),
              requestNamespace: "provider:features",
              thread: {
                threadId,
                providerSessionId: "provider:features",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities,
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
              getProjectThreadRecords: (input) =>
                Effect.succeed(idleThreadProjection(liveThreadShell(input.threadId))),
            }),
            Layer.mock(FeatureService)({
              attachThread: (input) => {
                calls.push(input);
                return Effect.succeed(snapshot);
              },
              detachThread: (input) => {
                calls.push(input);
                return Effect.succeed(snapshot);
              },
            }),
          ),
        ),
      ),
    ),
  );
};

it.effect("attaches and detaches the calling thread when no thread is named", () =>
  Effect.gen(function* () {
    const attached = yield* run("t3_feature_attach_thread", {
      workflowId: "feature-delivery",
      stageId: "build",
    });
    expect(attached.result).toEqual(snapshot);
    const [attach] = attached.calls;
    expect(attach).toMatchObject({
      threadId: caller,
      projectId,
      stageId: "build",
      title: caller,
      actorId: caller,
    });
    // The same thread, workflow and stage always name the same feature, so retries are safe.
    const again = yield* run("t3_feature_attach_thread", {
      workflowId: "feature-delivery",
      stageId: "build",
    });
    expect(again.calls[0]?.featureId).toBe(attach?.featureId);

    const other = ThreadId.make("thread:other");
    const detached = yield* run("t3_feature_detach_thread", { threadId: other });
    expect(detached.calls[0]).toMatchObject({ threadId: other, actorId: caller });
  }),
);

it.effect("a crew thread needs Manage workflows to attach or detach a thread", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE crew_runs (id TEXT, member_id TEXT, thread_id TEXT, allowed_tools_json TEXT)
    `;
    yield* sql`CREATE TABLE bots (id TEXT, allowed_tools_json TEXT)`;
    yield* sql`INSERT INTO crew_runs VALUES
      ('builder', 'role', 'bot-run:builder', '["orchestration"]'),
      ('manager', 'bot', 'bot-run:manager', '["crew.workflows"]')`;
    const attach = { workflowId: "feature-delivery", stageId: "build" };

    const refused = yield* run(
      "t3_feature_attach_thread",
      attach,
      ThreadId.make("bot-run:builder"),
    );
    expect(refused.result).toMatchObject({ code: "capability_denied" });
    expect(refused.calls).toEqual([]);

    // The grant stands in for thread control, which this run wasn't given.
    const crewOnly = new Set(["crew" as const]);
    const manager = ThreadId.make("bot-run:manager");
    expect((yield* run("t3_feature_attach_thread", attach, manager, crewOnly)).calls).toHaveLength(
      1,
    );
    expect((yield* run("t3_feature_detach_thread", {}, manager, crewOnly)).calls).toHaveLength(1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
