// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  botHeadquartersThreadId,
  CAPTAIN_BOT_ID,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import * as BotStore from "../bots/BotStore.ts";
import { CrewHandoffService } from "../crew/CrewHandoffService.ts";
import { CrewService, projectManagerMemberId } from "../crew/CrewService.ts";
import { CrewStore } from "../crew/CrewStore.ts";
import { WorkflowRuntimeLive } from "../workflows/runtimeLayer.ts";
import { WorkflowWorkspaceEmpty } from "../workflows/WorkflowWorkspace.ts";
import { WorkflowService } from "../workflows/WorkflowService.ts";
import { WorkflowStore } from "../workflows/WorkflowStore.ts";
import { WorkflowExecutionStore } from "../workflows/WorkflowExecutionStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  CrewTestOrchestration as OrchestrationLayerLive,
  seedCrewProject,
} from "../crew/CrewRuntime.testkit.ts";
import { OrchestratorV2 as OrchestrationEngineService } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { WorkflowExecutionService } from "../workflows/WorkflowExecutionService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { FeatureService, FeatureServiceLive, generateFeatureTitle } from "./FeatureService.ts";

const projectId = ProjectId.make("workflow-feature-project");
const scratchProjectId = ProjectId.make("workflow-feature-scratch");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
/** Title generation that never finishes, so a test decides when a title arrives. */
const TextGenerationPending = Layer.mock(TextGeneration.TextGeneration)({
  generateThreadTitle: () => Effect.never,
});

/** GitHub, answering for any github.com link. */
const SourceControlIssues = Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)(
  {
    resolveLink: ({ url }) =>
      url.host === "github.com"
        ? Effect.succeed({
            title: "Dark mode toggle",
            body: null,
            state: "open" as const,
            milestone: "v0.4",
            subIssues: { completed: 1, total: 3 },
          })
        : undefined,
  },
);

const encodeBotIdentity = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);

const withSystem = <E>(
  exercise: Effect.Effect<
    void,
    E,
    | FeatureService
    | CrewService
    | CrewStore
    | WorkflowService
    | WorkflowStore
    | WorkflowExecutionStore
    | WorkflowExecutionService
    | OrchestrationEngineService
    | ProjectionStore.ProjectionStoreV2
    | CrewHandoffService
    | BotStore.BotStore
    | ProjectStore.ProjectStoreV2
    | ServerSettingsService
    | SqlClient.SqlClient
    | TextGeneration.TextGeneration
    | SourceControlProviderRegistry.SourceControlProviderRegistry
  >,
) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "feature-integration-")),
    );
    const orchestration = OrchestrationLayerLive;
    const layer = FeatureServiceLive.pipe(
      Layer.provideMerge(
        WorkflowRuntimeLive.pipe(
          Layer.provide(WorkflowWorkspaceEmpty),
          Layer.provide(orchestration),
        ),
      ),
      Layer.provideMerge(orchestration),
      // Stateless over SQLite, so seeded threads read back through the orchestrator.
      Layer.provideMerge(ProjectionStore.layer),
      Layer.provideMerge(SqlitePersistence.layerFromPath(NodePath.join(directory, "state.sqlite"))),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "feature-test-" })),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(TextGenerationPending),
      Layer.provideMerge(SourceControlIssues),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(NodeServices.layer),
      // Bots keep their headquarters in the Scratch project.
      Layer.provideMerge(
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/unused",
          ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      yield* seedCrewProject({
        projectId,
        title: "Feature project",
        workspaceRoot: directory,
      });
      yield* seedCrewProject({
        projectId: scratchProjectId,
        title: "Scratch",
        workspaceRoot: NodePath.join(directory, "scratch"),
      });
      yield* (yield* CrewService).ensureDefaults(modelSelection);
      yield* exercise;
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      ),
    );
  });

describe("feature creation", () => {
  effectIt.effect(
    "pins the selected workflow and named crew across edits and duplicate creation",
    () =>
      withSystem(
        Effect.gen(function* () {
          const features = yield* FeatureService;
          const workflows = yield* WorkflowService;
          const bots = yield* CrewService;
          const store = yield* CrewStore;
          const definition = yield* workflows.ensureStarterDefinition();
          const selected = {
            ...definition,
            id: "custom-crew",
            name: "Custom crew",
            roles: {
              ...definition.roles,
              second_planner: { roleId: "role:planner", roleRevision: 1, supervisor: "designer" },
            },
          };
          yield* workflows.createDefinition(selected);
          const input = {
            id: "selected-feature",
            projectId,
            title: "Selected workflow",
            brief: "Use the custom crew",
            workflowId: selected.id,
          };
          const created = yield* features.create(input);
          expect(created.workflowId).toBe(selected.id);
          expect(created.workflowRevision).toBe(selected.revision);
          expect((yield* features.get(created.id))?.workflowRevision).toBe(selected.revision);
          expect(created.crewAssignments.manager).toBe(projectManagerMemberId(projectId));
          expect(created.crewAssignments.second_planner).not.toBe(created.crewAssignments.planner);
          const crew = (yield* store.listMembersForProject(projectId)).filter(
            (bot) => bot.featureId === created.id,
          );
          expect(crew).toHaveLength(6);
          expect(crew.every((bot) => bot.roleRevision === 1)).toBe(true);
          expect(
            yield* store.canDelegate(
              created.crewAssignments.designer!,
              created.crewAssignments.second_planner!,
              projectId,
            ),
          ).toBe(true);
          expect(
            yield* store.canDelegate(
              created.crewAssignments.manager!,
              created.crewAssignments.second_planner!,
              projectId,
            ),
          ).toBe(false);
          const copy = yield* workflows.getFeatureCopy(created.id);
          const role = (yield* store.getRole("role:planner"))!;
          yield* bots.updateRole({
            ...role,
            expectedRevision: role.revision,
            instructions: "Updated planner",
          });
          const revised = {
            ...selected,
            revision: 2,
            roles: {
              ...selected.roles,
              planner: { ...definition.roles.planner!, roleRevision: 2 },
              second_planner: { ...selected.roles.second_planner, roleRevision: 2 },
            },
          };
          yield* workflows.reviseDefinition(revised, 1);
          expect(yield* features.create(input)).toEqual(created);
          expect(yield* features.get(created.id)).toEqual(created);
          expect(yield* workflows.getFeatureCopy(created.id)).toEqual(copy);
          expect((yield* store.getMember(created.crewAssignments.planner!))?.instructions).toBe(
            role.instructions,
          );
          expect(
            (yield* features.create({ ...input, workflowId: definition.id }).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          expect(
            (yield* features.setStatus(created.id, projectId, "closed")).crewAssignments,
          ).toEqual(created.crewAssignments);
          expect(
            (yield* features.setStatus(created.id, projectId, "open")).crewAssignments,
          ).toEqual(created.crewAssignments);
          expect(yield* workflows.getFeatureCopy(created.id)).toEqual(copy);
        }),
      ),
  );

  effectIt.effect(
    "rolls back a failed attachment and retries without leftover bots or copies",
    () =>
      withSystem(
        Effect.gen(function* () {
          const features = yield* FeatureService;
          const workflows = yield* WorkflowService;
          const store = yield* CrewStore;
          const bots = yield* CrewService;
          const input = {
            id: "recovered-feature",
            projectId,
            title: "Recover creation",
            brief: "Retry safely",
            workflowId: "feature-delivery",
          };
          expect((yield* features.create(input).pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* features.get(input.id)).toBeNull();
          expect(yield* workflows.getFeatureCopy(input.id)).toBeNull();
          yield* workflows.ensureStarterDefinition();
          // Fail after snapshot creation and the first bot insert to exercise transaction rollback.
          const lateInput = { ...input, id: "late-failure" };
          const collisionId = `feature-bot:${NodeCrypto.createHash("sha256")
            .update(encodeBotIdentity([lateInput.id, "designer"]))
            .digest("hex")
            .slice(0, 32)}`;
          yield* bots.createMember({
            id: collisionId,
            projectId,
            name: "Existing unrelated bot",
            instructions: "Keep me",
            allowedTools: [],
            modelSelection,
            runtimeMode: "approval-required",
          });
          expect((yield* features.create(lateInput).pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* features.get(lateInput.id)).toBeNull();
          expect(yield* workflows.getFeatureCopy(lateInput.id)).toBeNull();
          expect(
            (yield* store.listMembersForProject(projectId)).filter(
              (bot) => bot.featureId === lateInput.id,
            ),
          ).toHaveLength(0);
          const created = yield* features.create(input);
          expect(created.status).toBe("open");
          expect(yield* features.create(input)).toEqual(created);
        }),
      ),
  );

  effectIt.effect("swaps a composer feature's stand-in title for a generated one", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const crew = yield* CrewService;
        const executions = yield* WorkflowExecutionStore;
        const engine = yield* OrchestrationEngineService;
        yield* (yield* WorkflowService).ensureStarterDefinition();
        const standIn = "Um so let's add uh a dark mode toggle";
        const input = {
          id: "titled-feature",
          projectId,
          title: standIn,
          brief: `${standIn} to the settings page`,
          workflowId: "feature-delivery",
          autoTitle: true,
        };
        const feature = yield* features.create(input);
        expect(feature).not.toHaveProperty("autoTitle");
        // A retry may send a different stand-in once the title was replaced.
        expect(yield* features.create({ ...input, title: "Dark mode" })).toEqual(feature);
        yield* features.start(input.id, projectId);
        const managerRun = yield* crew.getRun(
          (yield* executions.get(input.id))!.bindings.planner!.dispatchRunId,
        );
        const managerThreadId = managerRun!.run.threadId;
        // A stage thread is named after the feature when it starts.
        yield* engine.dispatch({
          type: "thread.crew-stage.set",
          commandId: CommandId.make("titled-feature:stage-title"),
          threadId: managerThreadId,
          title: standIn,
        });

        yield* generateFeatureTitle(feature).pipe(
          Effect.provideService(TextGeneration.TextGeneration, {
            ...(yield* TextGeneration.TextGeneration),
            generateThreadTitle: () => Effect.succeed({ title: "  Dark mode toggle " }),
          }),
        );

        expect((yield* features.get(input.id))?.title).toBe("Dark mode toggle");
        const thread = (yield* engine.getThreadShell(managerThreadId))!;
        expect(thread.feature).toEqual({ id: input.id, title: "Dark mode toggle" });
        expect(thread.title).toBe("Dark mode toggle");
      }),
    ),
  );

  effectIt.effect("links an issue that the feature's threads show, and unlinks it", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const crew = yield* CrewService;
        const executions = yield* WorkflowExecutionStore;
        const engine = yield* OrchestrationEngineService;
        yield* (yield* WorkflowService).ensureStarterDefinition();
        const target = { id: "issue-feature", projectId };
        yield* features.create({
          ...target,
          title: "Dark mode",
          brief: "Add dark mode",
          workflowId: "feature-delivery",
        });
        yield* features.start(target.id, projectId);
        const run = yield* crew.getRun(
          (yield* executions.get(target.id))!.bindings.planner!.dispatchRunId,
        );
        const tagOf = () =>
          engine.getThreadShell(run!.run.threadId).pipe(Effect.map((shell) => shell!.feature));

        const linked = yield* features.setIssue({
          ...target,
          url: " https://github.com/owner/repo/issues/42#issuecomment-1 ",
        });
        const issue = {
          url: "https://github.com/owner/repo/issues/42",
          number: 42,
          title: "Dark mode toggle",
          state: "open",
          milestone: "v0.4",
          subIssues: { completed: 1, total: 3 },
        };
        expect(linked.issue).toEqual(issue);
        expect((yield* features.get(target.id))?.issue).toEqual(issue);
        expect(yield* tagOf()).toEqual({ id: target.id, title: "Dark mode", issue });
        expect((yield* features.board(projectId))[0]?.issue).toEqual(issue);

        const notAnIssue = yield* Effect.flip(
          features.setIssue({ ...target, url: "https://github.com/owner/repo/pull/7" }),
        );
        expect(notAnIssue.message).toBe("Paste a link to an issue");

        expect((yield* features.setIssue({ ...target, url: null })).issue).toBeNull();
        expect(yield* tagOf()).toEqual({ id: target.id, title: "Dark mode" });
      }),
    ),
  );

  effectIt.effect("binds a workflow's project manager role to the project's manager", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const store = yield* CrewStore;
        yield* (yield* WorkflowService).ensureStarterDefinition();
        const managerId = projectManagerMemberId(projectId);
        expect(yield* store.getMember(managerId)).toBeNull();
        const create = (id: string) =>
          features.create({
            id,
            projectId,
            title: id,
            brief: "Run the starter workflow",
            workflowId: "feature-delivery",
          });
        const first = yield* create("managed-one");
        const second = yield* create("managed-two");
        expect(first.crewAssignments.manager).toBe(managerId);
        expect(second.crewAssignments.manager).toBe(managerId);
        expect((yield* store.getMember(managerId))?.featureId).toBeNull();
        expect(first.crewAssignments.planner).not.toBe(second.crewAssignments.planner);
      }),
    ),
  );

  effectIt.effect("leads every project's features from the bot's one pinned headquarters", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const crew = yield* CrewService;
        const executions = yield* WorkflowExecutionStore;
        const engine = yield* OrchestrationEngineService;
        yield* (yield* WorkflowService).ensureStarterDefinition();
        const otherProjectId = ProjectId.make("workflow-feature-other");
        yield* seedCrewProject({
          projectId: otherProjectId,
          title: "Other project",
          workspaceRoot: NodePath.join(NodeOS.tmpdir(), "feature-other"),
        });
        const leads = (id: string, project: ProjectId) =>
          Effect.gen(function* () {
            yield* features.create({
              id,
              projectId: project,
              title: `Feature ${id}`,
              brief: "Run the starter workflow",
              workflowId: "feature-delivery",
            });
            yield* features.start(id, project);
            const bindings = (yield* executions.get(id))!.bindings;
            const thread = (role: string) =>
              crew.getRun(bindings[role]!.dispatchRunId).pipe(
                Effect.flatMap((view) => engine.getThreadShell(view!.run.threadId)),
                Effect.map((shell) => shell!),
              );
            return { bot: yield* thread("manager"), manager: yield* thread("planner") };
          });
        const first = yield* leads("lead-one", projectId);
        const second = yield* leads("lead-two", otherProjectId);

        expect(first.bot.id).toBe(botHeadquartersThreadId(CAPTAIN_BOT_ID));
        expect(second.bot.id).toBe(first.bot.id);
        expect(first.bot.projectId).toBe(scratchProjectId);
        expect(first.bot.title).toBe("Captain");
        expect(first.bot.pinnedAt).not.toBeNull();
        expect(first.bot.feature ?? null).toBeNull();

        expect(first.manager.projectId).toBe(projectId);
        expect(second.manager.projectId).toBe(otherProjectId);
        expect(first.manager.title).toBe("Project manager");
        expect(first.manager.feature).toEqual({ id: "lead-one", title: "Feature lead-one" });
        expect(second.manager.feature).toEqual({ id: "lead-two", title: "Feature lead-two" });
      }),
    ),
  );

  effectIt.effect("lets a bot's headquarters hand work to managers of the projects it owns", () =>
    withSystem(
      Effect.gen(function* () {
        const crew = yield* CrewService;
        const handoffs = yield* CrewHandoffService;
        const bots = yield* BotStore.BotStore;
        const theirs = ProjectId.make("workflow-feature-theirs");
        const captain = (yield* bots.get(CAPTAIN_BOT_ID))!;
        const social = { ...captain, id: "bot-social", name: "Social", position: 1 };
        expect(yield* bots.insert(social)).toBe(true);
        yield* seedCrewProject({
          projectId: theirs,
          title: "Social's project",
          workspaceRoot: NodePath.join(NodeOS.tmpdir(), "feature-theirs"),
          botId: social.id,
        });
        const headquarters = yield* crew.ensureHeadquarters(CAPTAIN_BOT_ID);
        const delegate = (id: string, project: ProjectId) =>
          handoffs.delegate({
            id,
            sourceThreadId: headquarters.threadId,
            targetMemberId: projectManagerMemberId(project),
            taskText: "Tidy the README",
          });

        // The manager doesn't exist yet; the bot's first request makes it.
        const handoff = yield* delegate("hq-owned", projectId);
        expect(handoff.projectId).toBe(projectId);
        expect((yield* crew.getMember(projectManagerMemberId(projectId)))?.projectId).toBe(
          projectId,
        );
        expect((yield* delegate("hq-theirs", theirs).pipe(Effect.result))._tag).toBe("Failure");
        // A workflow that bound the headquarters before a move keeps sending stages there.
        yield* crew.ensureProjectManager(theirs);
        const bound = yield* handoffs.delegate({
          id: "hq-bound",
          sourceThreadId: headquarters.threadId,
          targetMemberId: projectManagerMemberId(theirs),
          projectId: theirs,
          taskText: "Run the next stage",
          boundByWorkflow: true,
        });
        expect(bound.projectId).toBe(theirs);
      }),
    ),
  );

  effectIt.effect(
    "restores a deleted or archived headquarters and follows the bot's settings",
    () =>
      withSystem(
        Effect.gen(function* () {
          const crew = yield* CrewService;
          const bots = yield* BotStore.BotStore;
          const engine = yield* OrchestrationEngineService;
          const headquarters = yield* crew.ensureHeadquarters(CAPTAIN_BOT_ID);
          const shell = () => engine.getThreadShell(headquarters.threadId);

          yield* engine.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("test:archive-hq"),
            threadId: headquarters.threadId,
          });
          yield* crew.ensureHeadquarters(CAPTAIN_BOT_ID);
          const unarchived = yield* shell();
          expect(unarchived).not.toBeNull();
          expect(unarchived!.archivedAt).toBeNull();

          yield* engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("test:delete-hq"),
            threadId: headquarters.threadId,
          });
          yield* crew.ensureHeadquarters(CAPTAIN_BOT_ID);
          const restored = yield* shell();
          expect(restored).not.toBeNull();
          expect(restored!.deletedAt).toBeNull();
          expect(restored!.pinnedAt).toBeTruthy();

          // Switching the bot to Ask first reaches its headquarters' next turns.
          const captain = (yield* bots.get(CAPTAIN_BOT_ID))!;
          const runtimeMode =
            captain.runtimeMode === "full-access" ? "approval-required" : "full-access";
          expect(
            yield* bots.update(
              { ...captain, runtimeMode, revision: captain.revision + 1 },
              captain.revision,
            ),
          ).toBe(true);
          yield* crew.ensureHeadquarters(CAPTAIN_BOT_ID);
          expect((yield* shell())?.runtimeMode).toBe(runtimeMode);
        }),
      ),
  );

  effectIt.effect("deletes a workflow only once nothing still runs or starts on it", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const workflows = yield* WorkflowService;
        const bots = yield* BotStore.BotStore;
        yield* workflows.ensureStarterDefinition();
        yield* features.create({
          id: "uses-starter",
          projectId,
          title: "Ship the thing",
          brief: "Run the starter workflow",
          workflowId: "feature-delivery",
        });
        const refused = yield* workflows.deleteDefinition("feature-delivery").pipe(Effect.flip);
        expect(refused.message).toContain('"Ship the thing" still runs on it');

        // A finished feature keeps its own copy, so it no longer holds the workflow.
        yield* workflows.recordTrustedEvent("uses-starter", {
          id: "cancel",
          stepId: "plan",
          executionId: null,
          kind: "cancelled",
          runId: null,
          outcome: null,
          sourceKind: null,
          sourceId: null,
          actorId: "user",
          detail: null,
          occurredAt: "2026-10-14T00:00:00.000Z",
        });
        const captain = (yield* bots.get(CAPTAIN_BOT_ID))!;
        yield* bots.update(
          { ...captain, defaultWorkflowId: "feature-delivery", revision: captain.revision + 1 },
          captain.revision,
        );
        expect(
          (yield* workflows.deleteDefinition("feature-delivery").pipe(Effect.flip)).message,
        ).toContain("Captain starts its features with it");

        const current = (yield* bots.get(CAPTAIN_BOT_ID))!;
        yield* bots.update(
          { ...current, defaultWorkflowId: null, revision: current.revision + 1 },
          current.revision,
        );
        yield* workflows.deleteDefinition("feature-delivery");
        expect(yield* workflows.getLatestDefinition("feature-delivery")).toBeNull();
        expect((yield* workflows.getFeatureCopy("uses-starter"))?.definition.id).toBe(
          "feature-delivery",
        );
        // The starter can come back after it was deleted.
        expect((yield* workflows.ensureStarterDefinition()).revision).toBe(1);
      }),
    ),
  );

  effectIt.effect("requires a terminal workflow before closing an attached execution", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const workflows = yield* WorkflowService;
        const executions = yield* WorkflowExecutionStore;
        yield* workflows.ensureStarterDefinition();
        const feature = yield* features.create({
          id: "executing-feature",
          projectId,
          title: "Running",
          brief: "Keep work visible",
          workflowId: "feature-delivery",
        });
        yield* executions.attach(feature.id, {});
        expect(
          (yield* features.setStatus(feature.id, projectId, "closed").pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* features.get(feature.id))?.status).toBe("open");
        yield* workflows.recordTrustedEvent(feature.id, {
          id: "cancel",
          stepId: "plan",
          executionId: null,
          kind: "cancelled",
          runId: null,
          outcome: null,
          sourceKind: null,
          sourceId: null,
          actorId: "user",
          detail: null,
          occurredAt: "2026-09-30T00:00:00.000Z",
        });
        expect((yield* features.setStatus(feature.id, projectId, "closed")).status).toBe("closed");
        expect((yield* features.setStatus(feature.id, projectId, "open")).status).toBe("open");
        expect((yield* workflows.getFeatureSnapshot(feature.id, projectId))?.cancelled).toBe(true);
      }),
    ),
  );
  effectIt.effect("lists board cards only for features that run a workflow", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const workflows = yield* WorkflowService;
        yield* workflows.ensureStarterDefinition();
        yield* features.create({
          id: "board-feature",
          projectId,
          title: "On the board",
          brief: "Run the starter workflow",
          workflowId: "feature-delivery",
        });
        yield* features.create({
          id: "plain-feature",
          projectId,
          title: "No workflow",
          brief: "Bots only",
        });
        const board = yield* features.board(projectId);
        expect(board.map((card) => card.featureId)).toEqual(["board-feature"]);
        expect(board[0]).toMatchObject({
          title: "On the board",
          started: false,
          threadId: null,
          workflow: { id: "feature-delivery", revision: 1, latestRevision: 1 },
          stage: { stepId: "plan", index: 1, role: "planner", gate: true },
        });
      }),
    ),
  );

  effectIt.effect("creates a feature with independent enabled bot instances exactly once", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workflow-feature-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      const orchestration = OrchestrationLayerLive;
      const crewRuntime = WorkflowRuntimeLive.pipe(
        Layer.provide(WorkflowWorkspaceEmpty),
        Layer.provide(orchestration),
      );
      const layer = FeatureServiceLive.pipe(
        Layer.provideMerge(crewRuntime),
        Layer.provideMerge(orchestration),
        Layer.provide(SqlitePersistence.layerFromPath(databasePath)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "feature-test-" })),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(TextGenerationPending),
        Layer.provideMerge(SourceControlIssues),
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        Layer.provideMerge(NodeServices.layer),
      );
      const exercise = Effect.gen(function* () {
        const bots = yield* CrewService;
        const crewStore = yield* CrewStore;
        const features = yield* FeatureService;
        yield* seedCrewProject({
          projectId,
          title: "Workflow feature project",
          workspaceRoot: `/tmp/${projectId}`,
        });
        yield* bots.ensureDefaults(modelSelection);
        const extra = yield* bots.createRole({
          id: "role:writer",
          name: "Writer",
          instructions: "Write the feature copy.",
          allowedTools: [],
          modelSelection,
          runtimeMode: "approval-required",
          autoCreateForFeature: true,
        });
        const disabled = yield* bots.createRole({
          id: "role:disabled",
          name: "Disabled",
          instructions: "Do not copy me.",
          allowedTools: [],
          modelSelection,
          runtimeMode: "approval-required",
          autoCreateForFeature: true,
        });
        yield* bots.updateRole({
          ...disabled,
          expectedRevision: disabled.revision,
          enabled: false,
        });

        const input = {
          id: "feature-one",
          projectId,
          title: "Deliver the feature",
          brief: "Plan, build, test, and review it.",
        };
        const created = yield* features.create(input);
        expect(created.status).toBe("open");
        expect(created.updatedAt).toBe(created.createdAt);
        expect(created.workflowId).toBeNull();
        expect(created.workflowRevision).toBeNull();
        const featureBots = (yield* crewStore.listMembersForProject(projectId)).filter(
          (bot) => bot.featureId === input.id,
        );
        expect(featureBots).toHaveLength(6);
        expect(featureBots.map((bot) => bot.roleId)).toContain(extra.id);
        expect(featureBots.map((bot) => bot.roleId)).not.toContain(disabled.id);
        expect(featureBots.every((bot) => bot.roleRevision === 1)).toBe(true);
        for (const bot of featureBots) {
          expect(
            yield* crewStore.canDelegate(projectManagerMemberId(projectId), bot.id, projectId),
          ).toBe(true);
        }

        yield* bots.updateRole({
          ...extra,
          expectedRevision: extra.revision,
          instructions: "New role instructions",
        });
        expect(yield* features.create(input)).toEqual(created);
        expect((yield* features.listByProject(projectId)).map((feature) => feature.id)).toEqual([
          input.id,
        ]);
        expect(
          (yield* crewStore.getMember(featureBots.find((bot) => bot.roleId === extra.id)!.id))
            ?.instructions,
        ).toBe("Write the feature copy.");
        expect(
          (yield* features.create({ ...input, title: "Different" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* features
            .create({ ...input, id: "bad-feature", projectId: ProjectId.make("missing-project") })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* features.get("bad-feature")).toBeNull();
        const closed = yield* features.setStatus(created.id, projectId, "closed");
        expect(closed.status).toBe("closed");
        expect(yield* features.setStatus(created.id, projectId, "closed")).toEqual(closed);
        expect(
          (yield* features
            .setStatus(created.id, ProjectId.make("another-project"), "open")
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const reopened = yield* features.setStatus(created.id, projectId, "open");
        expect(reopened.status).toBe("open");
        expect(reopened.crewAssignments).toEqual(created.crewAssignments);
        expect(
          (yield* crewStore.listMembersForProject(projectId)).filter(
            (bot) => bot.featureId === created.id,
          ),
        ).toHaveLength(6);
      }).pipe(Effect.provide(layer));
      yield* exercise.pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );
});

/** A person's thread whose latest turn has `status`, ending with `reply` when it has one. */
const seedThread = (
  id: string,
  options: {
    readonly status: OrchestrationV2Run["status"];
    readonly reply?: string;
    readonly project?: ProjectId;
    readonly archived?: boolean;
  },
) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(id);
    const runId = RunId.make(`${id}:run`);
    const instanceId = ProviderInstanceId.make("codex");
    yield* store.apply({
      id: EventId.make(`${id}:created`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId: options.project ?? projectId,
        title: "Reconnect loop after sleep",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "fix/reconnect",
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: options.archived ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const message = (role: "user" | "assistant", text: string) =>
      store.apply({
        id: EventId.make(`${id}:${role}`),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: MessageId.make(`${id}:${role}`),
          threadId,
          runId,
          nodeId: null,
          role,
          text,
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
        },
      });
    yield* message("user", "The socket reconnects twice after the laptop sleeps.");
    yield* setRun(id, options.status);
    if (options.reply) yield* message("assistant", options.reply);
    return threadId;
  });

const setRun = (id: string, status: OrchestrationV2Run["status"]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(id);
    const instanceId = ProviderInstanceId.make("codex");
    yield* store.apply({
      id: EventId.make(`${id}:run:${status}`),
      type: "run.updated",
      threadId,
      runId: RunId.make(`${id}:run`),
      occurredAt: now,
      payload: {
        id: RunId.make(`${id}:run`),
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "test" },
        providerThreadId: null,
        userMessageId: MessageId.make(`${id}:user`),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: status === "completed" ? now : null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
  });

describe("making a thread a feature", () => {
  const attach = (threadId: ThreadId, stageId: string, featureId = "attached") =>
    Effect.gen(function* () {
      const workflow = yield* (yield* WorkflowService).ensureStarterDefinition();
      return yield* (yield* FeatureService).attachThread({
        featureId,
        projectId,
        threadId,
        workflowId: workflow.id,
        stageId,
        title: "Reconnect loop after sleep",
        actorId: "person",
      });
    });
  const status = (
    snapshot: { readonly steps: ReadonlyArray<{ readonly id: string; readonly status: string }> },
    stepId: string,
  ) => snapshot.steps.find((step) => step.id === stepId)?.status;

  effectIt.effect("skips earlier stages and finishes the stage when the thread's turn ends", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const threadId = yield* seedThread("thread:attach", { status: "running" });
        const snapshot = yield* attach(threadId, "review");
        for (const stepId of ["plan", "design", "build", "qa"]) {
          expect(status(snapshot, stepId)).toBe("skipped");
        }
        expect(snapshot.activeStepId).toBe("review");
        expect(snapshot.steps.find((step) => step.id === "review")).toMatchObject({
          status: "taken-over",
          threadId,
          runId: null,
        });
        expect((yield* features.get("attached"))?.brief).toBe(
          "The socket reconnects twice after the laptop sleeps.",
        );
        expect(yield* features.threadLink(projectId, threadId)).toEqual({
          stage: {
            featureId: "attached",
            stepId: "review",
            index: 5,
            total: 6,
            state: "working",
            current: true,
          },
          attachable: true,
        });
        // A retry returns the same feature; the same ID for another stage, or a second
        // feature for the same thread, is refused.
        expect((yield* attach(threadId, "review")).activeStepId).toBe("review");
        expect((yield* attach(threadId, "qa").pipe(Effect.flip)).message).toContain(
          "another request",
        );
        expect(
          (yield* (yield* FeatureService)
            .attachThread({
              featureId: "attached",
              projectId,
              threadId,
              workflowId: "feature-delivery",
              stageId: "review",
              title: "Another title",
              actorId: "person",
            })
            .pipe(Effect.flip)).message,
        ).toContain("another request");
        expect((yield* attach(threadId, "review", "second").pipe(Effect.flip)).message).toContain(
          "already a feature's current stage",
        );

        // A failed turn leaves the stage open; a finished one completes it with the reply.
        const execution = yield* WorkflowExecutionService;
        yield* setRun("thread:attach", "failed");
        yield* execution.reconcileFeature("attached");
        expect((yield* (yield* WorkflowService).getFeatureState("attached"))?.activeStepId).toBe(
          "review",
        );
        yield* setRun("thread:attach", "completed");
        yield* execution.reconcileFeature("attached");
        const done = (yield* (yield* WorkflowService).getFeatureSnapshot("attached", projectId))!;
        expect(done.completed).toBe(true);
        expect(done.recentEvents.at(-1)).toMatchObject({
          kind: "completed",
          stepId: "review",
          outcome: "approved",
          sourceKind: "workflow",
          detail: 'Finished in thread "Reconnect loop after sleep"',
        });
        expect((yield* features.threadLink(projectId, threadId)).stage?.current).toBe(false);
      }),
    ),
  );

  effectIt.effect("hands a finished thread's result to the stage's gate straight away", () =>
    withSystem(
      Effect.gen(function* () {
        const threadId = yield* seedThread("thread:finished", {
          status: "completed",
          reply: "The plan: clear the backoff timer on sleep.",
        });
        const snapshot = yield* attach(threadId, "plan");
        expect(snapshot.state).toBe("approval");
        expect(snapshot.steps.find((step) => step.id === "plan")).toMatchObject({
          status: "awaiting-approval",
          pendingOutcome: "ready",
          threadId,
        });
        expect(snapshot.recentEvents.at(-1)?.detail).toBe(
          "The plan: clear the backoff timer on sleep.",
        );

        // Detached at the gate and reopened, the stage waits for a new turn: the finished one
        // has already been handed on, and reconciling must not record it again.
        const features = yield* FeatureService;
        yield* features.detachThread({
          projectId,
          threadId,
          requestId: "detach-at-gate",
          actorId: "person",
        });
        const reopened = yield* features.reopen({
          id: "attached",
          projectId,
          requestId: "reopen-at-gate",
          actorId: "person",
        });
        expect(reopened.steps.find((step) => step.id === "plan")).toMatchObject({
          status: "taken-over",
          threadId,
        });
        yield* (yield* WorkflowExecutionService).reconcileFeature("attached");
        expect(
          (yield* (yield* WorkflowService).getFeatureState("attached"))?.steps.get("plan")?.status,
        ).toBe("taken-over");
      }),
    ),
  );

  effectIt.effect("detaches to a plain thread, and reopening reattaches it", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const threadId = yield* seedThread("thread:detach", { status: "running" });
        yield* attach(threadId, "review");
        const detach = (requestId: string) =>
          features.detachThread({ projectId, threadId, requestId, actorId: "person" });
        const detached = yield* detach("detach-1");
        expect(detached.cancelled).toBe(true);
        expect(detached.recentEvents.at(-1)?.detail).toBe("Detached from the workflow");
        expect((yield* features.threadLink(projectId, threadId)).stage?.current).toBe(false);
        expect((yield* detach("detach-1")).cancelled).toBe(true);
        expect((yield* detach("detach-2").pipe(Effect.flip)).message).toContain(
          "not a feature's current stage",
        );

        const reopen = (requestId: string) =>
          features.reopen({ id: "attached", projectId, requestId, actorId: "person" });
        const reopened = yield* reopen("reopen-1");
        expect(reopened.steps.find((step) => step.id === "review")).toMatchObject({
          status: "taken-over",
          threadId,
        });
        expect((yield* features.threadLink(projectId, threadId)).stage?.current).toBe(true);

        // Once the thread joins another feature, the first one can no longer take it back,
        // and a retried detach still lands on the feature it first detached.
        yield* detach("detach-3");
        yield* attach(threadId, "review", "second");
        expect((yield* reopen("reopen-2").pipe(Effect.flip)).message).toContain(
          "now another feature's stage",
        );
        expect((yield* detach("detach-3")).featureId).toBe("attached");
        expect((yield* features.threadLink(projectId, threadId)).stage).toMatchObject({
          featureId: "second",
          current: true,
        });
      }),
    ),
  );

  effectIt.effect("refuses threads it cannot make a feature", () =>
    withSystem(
      Effect.gen(function* () {
        const archived = yield* seedThread("thread:archived", {
          status: "running",
          archived: true,
        });
        expect((yield* attach(archived, "review").pipe(Effect.flip)).message).toContain(
          "Unarchive",
        );
        const elsewhere = yield* seedThread("thread:elsewhere", {
          status: "running",
          project: ProjectId.make("another-project"),
        });
        expect((yield* attach(elsewhere, "review").pipe(Effect.flip)).message).toContain(
          "not found in project",
        );
        const plain = yield* seedThread("thread:off-path", { status: "running" });
        expect((yield* attach(plain, "change_review").pipe(Effect.flip)).message).toContain(
          "workflow's path",
        );
        expect(yield* (yield* FeatureService).get("attached")).toBeNull();
      }),
    ),
  );
});
