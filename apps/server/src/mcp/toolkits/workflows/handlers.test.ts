import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  botHeadquartersThreadId,
  CAPTAIN_BOT_ID,
  EnvironmentId,
  PROJECT_MANAGER_ROLE_ID,
  ProjectId,
  ProviderInstanceId,
  type RoleConfig,
  type RuntimeMode,
  ThreadId,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { BotProjects, BotProjectsError } from "../../../bots/BotProjects.ts";
import { ServerConfig } from "../../../config.ts";
import { CrewService } from "../../../crew/CrewService.ts";
import { CrewTestOrchestration, seedCrewProject } from "../../../crew/CrewRuntime.testkit.ts";
import { CrewRuntimeLive } from "../../../crew/runtimeLayer.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { WorkflowService, WorkflowServiceLive } from "../../../workflows/WorkflowService.ts";
import { WorkflowStageHandoffStoreLive } from "../../../workflows/WorkflowStageHandoffStore.ts";
import { WorkflowStoreLive } from "../../../workflows/WorkflowStore.ts";
import { WorkflowWorkspaceEmpty } from "../../../workflows/WorkflowWorkspace.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as WorkflowsHandlers from "./handlers.ts";
import { WorkflowsToolkit } from "./tools.ts";

const person = ThreadId.make("thread:person");
const captain = botHeadquartersThreadId(CAPTAIN_BOT_ID);
const projectId = ProjectId.make("workflow-tools-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

interface Called {
  readonly isFailure: boolean;
  readonly result: unknown;
}
const failure = (called: Called) =>
  called.result as { readonly code: string; readonly message: string };

/** What t3_feature_start asked BotProjects for; its own behavior is tested in BotProjects.test.ts. */
const featureStarts: Array<{ readonly botId: string; readonly projectId: string }> = [];
const BotProjectsRecorder = Layer.mock(BotProjects)({
  startFeature: (input) => {
    if (input.projectId === "not-mine") {
      return Effect.fail(new BotProjectsError({ reason: "Captain doesn't own project not-mine" }));
    }
    featureStarts.push({ botId: input.botId, projectId: input.projectId });
    return Effect.succeed({
      featureId: input.featureId ?? "feature:new",
      projectId: input.projectId,
      title: input.title,
      workflowId: input.workflowId ?? "feature-delivery",
      workflowRevision: 1,
      state: "working" as const,
      stage: "plan",
      threadId: null,
    });
  },
});

/** Calls a tool as `threadId` running in `runtimeMode`; failures come back as results. */
const call = (
  tool: keyof typeof WorkflowsToolkit.tools,
  params: Record<string, unknown>,
  threadId: ThreadId = person,
  runtimeMode: RuntimeMode = "full-access",
  capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["orchestration"]),
) =>
  Effect.gen(function* () {
    const toolkit = yield* WorkflowsToolkit;
    const results = yield* toolkit
      .handle(tool, params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)! as Called;
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(WorkflowsHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:workflows"),
              requestNamespace: "provider:workflows",
              thread: {
                threadId,
                providerSessionId: "provider:workflows",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities,
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(liveThreadShell(id, { runtimeMode })),
              getProjectThreadRecords: (input) =>
                Effect.succeed(idleThreadProjection(liveThreadShell(input.threadId))),
            }),
            BotProjectsRecorder,
          ),
        ),
      ),
    ),
  );

const workflows = WorkflowServiceLive.pipe(
  Layer.provideMerge(WorkflowStoreLive),
  Layer.provideMerge(WorkflowStageHandoffStoreLive),
  Layer.provideMerge(WorkflowWorkspaceEmpty),
  Layer.provideMerge(CrewRuntimeLive.pipe(Layer.provide(CrewTestOrchestration))),
);
const layer = Layer.mergeAll(CrewTestOrchestration, workflows).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "workflow-tools-test-" })),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("agents create, edit and delete workflows and roles through MCP", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crew = yield* CrewService;
    const workflowService = yield* WorkflowService;
    yield* seedCrewProject({ projectId, title: "Workflow tools", workspaceRoot: "/tmp/wt" });
    yield* crew.ensureDefaults(modelSelection);

    const { roles } = (yield* call("t3_role_list", {})).result as {
      roles: ReadonlyArray<{ id: string; revision: number }>;
    };
    const pin = (roleId: string, supervisor: string | null = "manager") => ({
      roleId,
      roleRevision: roles.find((role) => role.id === roleId)!.revision,
      supervisor,
    });
    const definition: WorkflowDefinition = {
      schemaVersion: 2,
      id: "research-build-review",
      name: "Research, build, review",
      revision: 1,
      start: "research",
      roles: {
        manager: pin(PROJECT_MANAGER_ROLE_ID, null),
        researcher: pin("role:planner"),
        builder: pin("role:builder"),
        reviewer: pin("role:reviewer"),
      },
      steps: {
        research: { type: "task", role: "researcher", task: "Research", next: { ready: "build" } },
        build: { type: "task", role: "builder", task: "Build", next: { built: "review" } },
        review: { type: "task", role: "reviewer", task: "Review", next: { approved: "end" } },
        end: { type: "end" },
      },
      defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 30 },
    };
    expect((yield* call("t3_workflow_create", { definition })).result).toEqual(definition);
    const list = () =>
      call("t3_workflow_list", {}).pipe(
        Effect.map((called) => (called.result as { workflows: ReadonlyArray<unknown> }).workflows),
      );
    expect(yield* list()).toContainEqual({
      id: definition.id,
      name: definition.name,
      revision: 1,
      stages: ["research", "build", "review"],
    });

    // A feature that started on revision 1 stays on it.
    yield* workflowService.copyForFeature("running", projectId, definition.id);

    // Add a QA stage: read, edit, put back one revision higher.
    const current = (yield* call("t3_workflow_get", { id: definition.id }))
      .result as WorkflowDefinition;
    const withQa: WorkflowDefinition = {
      ...current,
      revision: 2,
      roles: { ...current.roles, qa: pin("role:qa-tester") },
      steps: {
        ...current.steps,
        build: { type: "task", role: "builder", task: "Build", next: { built: "qa" } },
        qa: { type: "task", role: "qa", task: "Test", next: { passed: "review" }, gate: true },
      },
    };
    expect(
      (yield* call("t3_workflow_update", { definition: withQa, expectedRevision: 1 })).result,
    ).toEqual(withQa);
    expect(yield* list()).toContainEqual({
      id: definition.id,
      name: definition.name,
      revision: 2,
      stages: ["research", "build", "qa", "review"],
    });
    expect((yield* workflowService.getFeatureCopy("running"))?.definition.revision).toBe(1);

    // Errors say what to fix.
    const stale = yield* call("t3_workflow_update", { definition: withQa, expectedRevision: 1 });
    expect(stale.isFailure).toBe(true);
    expect(failure(stale).message).toContain("reload and retry");
    const unknownRole = yield* call("t3_workflow_update", {
      definition: {
        ...withQa,
        revision: 3,
        roles: { ...withQa.roles, qa: { roleId: "role:nope", roleRevision: 1, supervisor: null } },
      },
      expectedRevision: 2,
    });
    expect(failure(unknownRole).message).toBe("Workflow role role:nope does not exist");

    // Roles: create one, then retire it.
    const role = (yield* call("t3_role_create", {
      id: "role:docs",
      name: "Docs writer",
      instructions: "Write the docs",
      allowedTools: ["crew.respond", "crew.ask"],
      modelSelection,
      runtimeMode: "approval-required",
      autoCreateForFeature: true,
    })).result as RoleConfig;
    expect(role).toMatchObject({ id: "role:docs", revision: 1, enabled: true });
    // Bot-only grants never reach a role, so a stage can't change the library.
    const stageWithGrant = yield* call("t3_role_create", {
      ...role,
      id: "role:sneaky",
      allowedTools: ["crew.respond", "crew.workflows"],
    });
    expect(failure(stageWithGrant).message).toBe(
      "crew.workflows is for bots and can't be given to a role",
    );
    const duplicate = yield* call("t3_role_create", { ...role, name: "Again" });
    expect(failure(duplicate).message).toBe("Role ID is already in use: role:docs");
    const { revision, enabled: _enabled, ...fields } = role;
    expect(
      (yield* call("t3_role_update", { ...fields, expectedRevision: revision, enabled: false }))
        .result,
    ).toMatchObject({ enabled: false, revision: 2 });

    // Delete is refused while a bot starts its features with the workflow.
    yield* sql`UPDATE bots SET default_workflow_id = ${definition.id} WHERE id = ${CAPTAIN_BOT_ID}`;
    const inUse = yield* call("t3_workflow_delete", { id: definition.id });
    expect(inUse.isFailure).toBe(true);
    expect(failure(inUse).message).toContain("Captain starts its features with it");
    yield* sql`UPDATE bots SET default_workflow_id = NULL WHERE id = ${CAPTAIN_BOT_ID}`;
    expect((yield* call("t3_workflow_delete", { id: definition.id })).result).toEqual({
      deleted: true,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("bots need the Manage workflows grant; other threads need full access to write", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedCrewProject({ projectId, title: "Workflow tools", workspaceRoot: "/tmp/wt" });
    yield* (yield* CrewService).ensureDefaults(modelSelection);
    yield* sql`
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at)
      VALUES ('bot-hq:bot-captain', ${CAPTAIN_BOT_ID}, ${projectId}, ${captain}, 'Lead', 'Captain',
        '', '[]', 1, '{}', 'approval-required', '2026-10-15')
    `;
    const starter = yield* (yield* WorkflowService).ensureStarterDefinition();
    const copy = { ...starter, id: "copy", name: "Copy", revision: 1 };

    // Captain holds the grant from its migration, so it may write without full access.
    const created = yield* call(
      "t3_workflow_create",
      { definition: copy },
      captain,
      "approval-required",
    );
    expect(created.isFailure).toBe(false);

    yield* sql`UPDATE bots SET allowed_tools_json = '["crew.delegate"]' WHERE id = ${CAPTAIN_BOT_ID}`;
    for (const result of [
      yield* call("t3_workflow_list", {}, captain),
      yield* call("t3_role_list", {}, captain),
      yield* call("t3_workflow_delete", { id: "copy" }, captain),
    ]) {
      expect(result.isFailure).toBe(true);
      expect(failure(result).code).toBe("capability_denied");
    }

    // Ordinary threads follow the t3_bot_* rule: anyone reads, full access writes.
    expect((yield* call("t3_workflow_list", {}, person, "approval-required")).isFailure).toBe(
      false,
    );
    const refused = yield* call("t3_workflow_delete", { id: "copy" }, person, "approval-required");
    expect(failure(refused).code).toBe("capability_denied");
    // As with t3_bot_*, a credential that can't control threads changes nothing.
    const previewOnly = yield* call(
      "t3_workflow_delete",
      { id: "copy" },
      person,
      "full-access",
      new Set(["preview"]),
    );
    expect(failure(previewOnly).code).toBe("capability_denied");
    expect((yield* call("t3_workflow_delete", { id: "copy" }, person)).isFailure).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("a bot with Manage workflows starts features as itself; nothing else can", () =>
  Effect.gen(function* () {
    featureStarts.length = 0;
    const sql = yield* SqlClient.SqlClient;
    yield* seedCrewProject({ projectId, title: "Workflow tools", workspaceRoot: "/tmp/wt" });
    yield* (yield* CrewService).ensureDefaults(modelSelection);
    yield* sql`
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at)
      VALUES ('bot-hq:bot-captain', ${CAPTAIN_BOT_ID}, ${projectId}, ${captain}, 'Lead', 'Captain',
        '', '[]', 1, '{}', 'approval-required', '2026-10-15')
    `;
    const input = { projectId, title: "Dark mode", brief: "Add a dark mode toggle" };

    // Captain holds the grant from its migration and starts the feature as itself.
    const started = yield* call("t3_feature_start", input, captain, "approval-required");
    expect(started.isFailure).toBe(false);
    expect(started.result).toMatchObject({ featureId: "feature:new", stage: "plan" });
    expect(featureStarts).toEqual([{ botId: CAPTAIN_BOT_ID, projectId }]);

    // The service's refusal reaches the agent as it was written.
    const notMine = yield* call(
      "t3_feature_start",
      { ...input, projectId: "not-mine" },
      captain,
      "approval-required",
    );
    expect(failure(notMine)).toMatchObject({
      code: "invalid_request",
      message: "Captain doesn't own project not-mine",
    });

    // An ordinary thread has no bot to start features for, even with full access.
    const fromPerson = yield* call("t3_feature_start", input, person);
    expect(failure(fromPerson).code).toBe("capability_denied");

    yield* sql`UPDATE bots SET allowed_tools_json = '["crew.delegate"]' WHERE id = ${CAPTAIN_BOT_ID}`;
    const withoutGrant = yield* call("t3_feature_start", input, captain, "approval-required");
    expect(failure(withoutGrant).code).toBe("capability_denied");
    expect(featureStarts).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);
