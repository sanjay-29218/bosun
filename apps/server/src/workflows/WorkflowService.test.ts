// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  PROJECT_MANAGER_ROLE_ID,
  ProjectId,
  ProviderInstanceId,
  type WorkflowDefinition,
  type WorkflowStepEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { CrewService } from "../crew/CrewService.ts";
import { CrewHandoffStore } from "../crew/CrewHandoffStore.ts";
import { CrewRuntimeLive } from "../crew/runtimeLayer.ts";
import { ServerConfig } from "../config.ts";
import {
  CrewTestOrchestration as OrchestrationLayerLive,
  seedCrewProject,
} from "../crew/CrewRuntime.testkit.ts";
import { OrchestratorV2 as OrchestrationEngineService } from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { WorkflowService, WorkflowServiceLive } from "./WorkflowService.ts";
import { WorkflowStore, WorkflowStoreLive } from "./WorkflowStore.ts";
import { WorkflowStageHandoffStoreLive } from "./WorkflowStageHandoffStore.ts";
import { WorkflowWorkspaceEmpty } from "./WorkflowWorkspace.ts";

const projectId = ProjectId.make("workflow-service-project");
const otherProjectId = ProjectId.make("workflow-service-other");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const roleId = "role:planner";

const definition: WorkflowDefinition = {
  schemaVersion: 2,
  id: "delivery",
  name: "Delivery",
  revision: 1,
  start: "plan",
  roles: {
    manager: { roleId: PROJECT_MANAGER_ROLE_ID, roleRevision: 1, supervisor: null },
    planner: { roleId, roleRevision: 1, supervisor: "manager" },
  },
  steps: {
    plan: { type: "task", role: "planner", task: "Plan", next: { ready: "end" } },
    end: { type: "end" },
  },
  defaults: {
    questions: "supervisor",
    failure: "pause",
    maxAttemptsPerExecution: 3,
    maxStepExecutions: 30,
  },
};

const stepEvent = (
  id: string,
  kind: WorkflowStepEvent["kind"],
  fields: Partial<WorkflowStepEvent> = {},
): WorkflowStepEvent => ({
  id,
  stepId: "plan",
  kind,
  executionId: null,
  runId: null,
  outcome: null,
  sourceKind: null,
  sourceId: null,
  actorId: "manager",
  detail: null,
  occurredAt: "2026-09-29T00:00:00.000Z",
  ...fields,
});

const createProject = (engine: OrchestrationEngineService["Service"], id: ProjectId) =>
  seedCrewProject({
    projectId: id,
    title: `Test ${id}`,
    workspaceRoot: `/tmp/${id}`,
  });

describe("Workflow service", () => {
  effectIt.effect("validates pinned roles and keeps feature copies on their revision", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workflow-service-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      const orchestration = OrchestrationLayerLive;
      const bots = CrewRuntimeLive.pipe(Layer.provide(orchestration));
      const workflows = WorkflowServiceLive.pipe(
        Layer.provideMerge(WorkflowStoreLive),
        Layer.provideMerge(WorkflowStageHandoffStoreLive),
        Layer.provideMerge(WorkflowWorkspaceEmpty),
        Layer.provideMerge(bots),
      );
      const layer = Layer.mergeAll(orchestration, workflows).pipe(
        Layer.provide(SqlitePersistence.layerFromPath(databasePath)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "workflow-test-" })),
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        Layer.provideMerge(NodeServices.layer),
      );
      const exercise = Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const crewService = yield* CrewService;
        const handoffs = yield* CrewHandoffStore;
        const workflow = yield* WorkflowService;
        yield* createProject(engine, projectId);
        yield* createProject(engine, otherProjectId);
        yield* crewService.ensureDefaults(modelSelection);
        yield* crewService.ensureProjectManager(projectId);

        const starter = yield* workflow.ensureStarterDefinition();
        expect(Object.keys(starter.steps)).toEqual(["plan", "design", "build", "qa", "end"]);
        expect(yield* workflow.ensureStarterDefinition()).toEqual(starter);

        const researcher = yield* crewService.createRole({
          id: "role:researcher",
          name: "Researcher",
          instructions: "Investigate the feature",
          modelSelection,
          runtimeMode: "approval-required",
          autoCreateForFeature: true,
        });
        yield* workflow.validateDefinition({
          ...definition,
          roles: {
            manager: definition.roles.manager!,
            researcher: {
              roleId: researcher.id,
              roleRevision: researcher.revision,
              supervisor: "manager",
            },
          },
          steps: {
            plan: { type: "task", role: "researcher", task: "Investigate", next: { ready: "end" } },
            end: { type: "end" },
          },
        });

        expect(
          (yield* workflow
            .validateDefinition({
              ...definition,
              roles: {
                ...definition.roles,
                planner: { roleId, roleRevision: 99, supervisor: "manager" },
              },
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");

        expect((yield* workflow.createDefinition(definition)).revision).toBe(1);
        const first = yield* workflow.copyForFeature("feature-one", projectId, definition.id);
        expect(first.definition.revision).toBe(1);
        const revised: WorkflowDefinition = { ...definition, name: "Delivery 2", revision: 2 };
        yield* workflow.reviseDefinition(revised, 1);
        expect((yield* workflow.reviseDefinition(revised, 1).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* workflow.copyForFeature("feature-one", projectId, definition.id)).definition,
        ).toEqual(definition);
        expect(
          (yield* workflow.copyForFeature("feature-two", projectId, definition.id)).definition,
        ).toEqual(revised);

        const template = yield* crewService.getRole(roleId);
        if (template === null) throw new Error("Default planner role was not created");
        const planner = yield* crewService.createMember({
          id: "feature-one-planner",
          projectId,
          featureId: "feature-one",
          roleId,
          name: template.name,
          instructions: template.instructions,
          allowedTools: template.allowedTools,
          modelSelection: template.modelSelection,
          runtimeMode: template.runtimeMode,
        });
        const managerRun = yield* crewService.createRun({
          id: "manager-run",
          memberId: `bot-manager:${projectId}`,
          projectId,
          taskText: "Supervise feature one",
        });
        const plannerRun = yield* crewService.createRun({
          id: "run-plan-1",
          memberId: planner.id,
          projectId,
          taskText: "Plan feature one",
        });

        const premature = yield* workflow
          .recordTrustedEvent(
            "feature-one",
            stepEvent("complete-too-early", "completed", {
              sourceKind: "handoff",
              sourceId: "handoff-1",
            }),
          )
          .pipe(Effect.result);
        expect(premature._tag).toBe("Failure");
        const start = stepEvent("start-plan", "started", {
          executionId: "execution-1",
          runId: "run-plan-1",
          sourceKind: "handoff",
          sourceId: "handoff-1",
        });
        const wrongFeatureRun = yield* workflow
          .recordTrustedEvent("feature-two", start)
          .pipe(Effect.result);
        expect(wrongFeatureRun._tag).toBe("Failure");
        expect(
          (yield* workflow.recordTrustedEvent("feature-one", start).pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* handoffs.insert({
          id: "handoff-1",
          parentId: null,
          sourceRunId: managerRun.id,
          targetMemberId: planner.id,
          targetRunId: plannerRun.id,
          projectId,
          taskText: "Plan feature one",
          contextText: "",
          depth: 1,
          status: "running",
          responseText: null,
          questionText: null,
          lastError: null,
          notificationState: "none",
          noticeVersion: 0,
          attempt: 1,
          createdAt: "2026-09-29T00:00:00.000Z",
          updatedAt: "2026-09-29T00:00:00.000Z",
        });
        expect(
          (yield* workflow.recordTrustedEvent("feature-one", start)).steps.get("plan")?.status,
        ).toBe("running");
        // A stage reports from its own thread, so its results cite the step's run.
        const question = stepEvent("question-plan", "question", {
          executionId: "execution-1",
          detail: "Which API?",
          sourceKind: "handoff",
          sourceId: "handoff-1",
        });
        expect(
          (yield* workflow.recordTrustedEvent("feature-one", question).pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* workflow.recordTrustedEvent("feature-one", { ...question, runId: plannerRun.id });
        expect((yield* workflow.getFeatureState("feature-one"))?.steps.get("plan")?.status).toBe(
          "needs-input",
        );
        const answer = stepEvent("answer-plan", "answered", {
          executionId: "execution-1",
          detail: "Use the current API",
          sourceKind: "decision",
          sourceId: "handoff-1",
          actorId: "person",
        });
        expect(
          (yield* workflow
            .recordTrustedEvent("feature-one", { ...answer, sourceId: "unrelated-handoff" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* workflow.recordTrustedEvent("feature-one", answer);
        const completion = stepEvent("complete-plan", "completed", {
          executionId: "execution-1",
          runId: plannerRun.id,
          outcome: "ready",
          detail: "Plan ready",
          sourceKind: "handoff",
          sourceId: "handoff-1",
        });
        for (const runId of [null, "different-run"]) {
          expect(
            (yield* workflow
              .recordTrustedEvent("feature-one", { ...completion, id: `complete-${runId}`, runId })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        yield* workflow.recordTrustedEvent("feature-one", completion);
        expect((yield* workflow.getFeatureState("feature-one"))?.completed).toBe(true);
        const snapshot = yield* workflow.getFeatureSnapshot("feature-one", projectId);
        expect(snapshot).toMatchObject({
          featureId: "feature-one",
          eventVersion: 4,
          historyLength: 4,
          completed: true,
          activeStepId: null,
        });
        expect(snapshot?.recentEvents.map((item) => item.id)).toEqual([
          "start-plan",
          "question-plan",
          "answer-plan",
          "complete-plan",
        ]);
        expect(snapshot?.steps.find((step) => step.id === "plan")?.threadId).toBe(
          plannerRun.threadId,
        );
        expect(
          (yield* workflow.getFeatureSnapshot("feature-one", otherProjectId).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(
          (yield* workflow.recordTrustedEvent("feature-one", start)).steps.get("plan")?.status,
        ).toBe("completed");
        const reusedId = yield* workflow
          .recordTrustedEvent("feature-one", { ...start, actorId: "another-manager" })
          .pipe(Effect.result);
        expect(reusedId._tag).toBe("Failure");

        yield* workflow.copyForFeature("feature-retry", projectId, definition.id);
        const retryBot = yield* crewService.createMember({
          id: "feature-retry-planner",
          projectId,
          featureId: "feature-retry",
          roleId,
          name: template.name,
          instructions: template.instructions,
          allowedTools: template.allowedTools,
          modelSelection: template.modelSelection,
          runtimeMode: template.runtimeMode,
        });
        const firstAttempt = yield* crewService.createRun({
          id: "retry-run-1",
          memberId: retryBot.id,
          projectId,
          taskText: "Plan retry feature",
        });
        yield* handoffs.insert({
          ...(yield* handoffs.get("handoff-1"))!,
          id: "handoff-retry",
          targetMemberId: retryBot.id,
          targetRunId: firstAttempt.id,
          status: "running",
          responseText: null,
          questionText: null,
        });
        yield* workflow.recordTrustedEvent(
          "feature-retry",
          stepEvent("retry-start-1", "started", {
            executionId: "retry-execution",
            runId: firstAttempt.id,
            sourceKind: "handoff",
            sourceId: "handoff-retry",
          }),
        );
        yield* handoffs.transition("handoff-retry", ["running"], "failed", "2026-09-29T00:00:02Z", {
          lastError: "Provider unavailable",
        });
        yield* workflow.recordTrustedEvent(
          "feature-retry",
          stepEvent("retry-failed-1", "failed", {
            executionId: "retry-execution",
            sourceKind: "handoff",
            sourceId: "handoff-retry",
            detail: "Provider unavailable",
          }),
        );
        yield* workflow.recordTrustedEvent(
          "feature-retry",
          stepEvent("retry-decision", "retry", { executionId: "retry-execution" }),
        );
        expect(yield* handoffs.retry("handoff-retry", "2026-09-29T00:00:03Z")).toBe(true);
        const secondHandoff = (yield* handoffs.get("handoff-retry"))!;
        const secondAttempt = yield* crewService.createRun({
          id: secondHandoff.targetRunId,
          memberId: retryBot.id,
          projectId,
          taskText: "Plan retry feature",
        });
        yield* workflow.recordTrustedEvent(
          "feature-retry",
          stepEvent("retry-start-2", "started", {
            executionId: "retry-execution",
            runId: secondAttempt.id,
            sourceKind: "handoff",
            sourceId: "handoff-retry",
          }),
        );
        expect((yield* workflow.getFeatureState("feature-retry"))?.steps.get("plan")).toMatchObject(
          {
            attempt: 2,
            runId: secondAttempt.id,
            status: "running",
          },
        );
        yield* workflow.recordTrustedEvent(
          "feature-retry",
          stepEvent("retry-cancel", "cancelled", { executionId: "retry-execution" }),
        );
        expect((yield* workflow.getFeatureState("feature-retry"))?.cancelled).toBe(true);

        yield* crewService.updateRole({
          ...template,
          expectedRevision: template.revision,
          enabled: false,
        });
        expect(
          (yield* workflow.copyForFeature("feature-one", projectId, definition.id)).definition,
        ).toEqual(definition);
        const disabledTemplate = yield* workflow
          .copyForFeature("feature-three", projectId, definition.id)
          .pipe(Effect.result);
        expect(disabledTemplate._tag).toBe("Failure");

        const duplicateWorkflow = yield* workflow.createDefinition(definition).pipe(Effect.result);
        expect(duplicateWorkflow._tag).toBe("Failure");
        const duplicateFeature = yield* workflow
          .copyForFeature("feature-one", otherProjectId, definition.id)
          .pipe(Effect.result);
        expect(duplicateFeature._tag).toBe("Failure");
      }).pipe(Effect.provide(layer));
      const afterRestart = Effect.gen(function* () {
        const store = yield* WorkflowStore;
        expect((yield* store.getFeatureCopy("feature-one"))?.definition).toEqual(definition);
        expect((yield* store.getFeatureCopy("feature-two"))?.definition.revision).toBe(2);
        expect((yield* store.listEvents("feature-one")).map((event) => event.kind)).toEqual([
          "started",
          "question",
          "answered",
          "completed",
        ]);
        expect((yield* store.listEvents("feature-retry")).map((event) => event.kind)).toEqual([
          "started",
          "failed",
          "retry",
          "started",
          "cancelled",
        ]);
      }).pipe(
        Effect.provide(
          WorkflowStoreLive.pipe(
            Layer.provide(SqlitePersistence.layerFromPath(databasePath)),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* exercise;
        yield* afterRestart;
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );
});
