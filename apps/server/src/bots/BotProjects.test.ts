import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CAPTAIN_BOT_ID, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { CrewService } from "../crew/CrewService.ts";
import { CrewTestOrchestration, seedCrewProject } from "../crew/CrewRuntime.testkit.ts";
import { FeatureService, FeatureServiceLive } from "../features/FeatureService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Repositories from "../sourceControl/SourceControlRepositoryService.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { WorkflowRuntimeLive } from "../workflows/runtimeLayer.ts";
import { WorkflowExecutionStore } from "../workflows/WorkflowExecutionStore.ts";
import { WorkflowService } from "../workflows/WorkflowService.ts";
import { WorkflowWorkspaceEmpty } from "../workflows/WorkflowWorkspace.ts";
import * as BotProjects from "./BotProjects.ts";
import * as BotStore from "./BotStore.ts";

const projectId = ProjectId.make("bot-projects-project");
const scratchProjectId = ProjectId.make("bot-projects-scratch");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const layer = BotProjects.layer.pipe(
  Layer.provideMerge(FeatureServiceLive),
  Layer.provideMerge(
    WorkflowRuntimeLive.pipe(
      Layer.provide(WorkflowWorkspaceEmpty),
      Layer.provide(CrewTestOrchestration),
    ),
  ),
  Layer.provideMerge(CrewTestOrchestration),
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-projects-test-" })),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
  Layer.provideMerge(
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => undefined,
    }),
  ),
  Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
  Layer.provideMerge(Layer.mock(Repositories.SourceControlRepositoryService)({})),
  Layer.provideMerge(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/unused",
      ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
      isScratchProject: (id) => Effect.succeed(id === scratchProjectId),
    }),
  ),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(NodeServices.layer),
);

/** Captain owns the project and the Scratch project, with the starter workflow in the library. */
const seed = Effect.gen(function* () {
  yield* seedCrewProject({ projectId, title: "Site", workspaceRoot: "/tmp/bot-projects" });
  yield* seedCrewProject({
    projectId: scratchProjectId,
    title: "Scratch",
    workspaceRoot: "/tmp/bot-projects-scratch",
  });
  yield* (yield* CrewService).ensureDefaults(modelSelection);
  return yield* (yield* WorkflowService).ensureStarterDefinition();
});

it.effect("starts a feature in a bot's project the way the composer does", () =>
  Effect.gen(function* () {
    const starter = yield* seed;
    const botProjects = yield* BotProjects.BotProjects;
    const features = yield* FeatureService;
    const executions = yield* WorkflowExecutionStore;

    const started = yield* botProjects.startFeature({
      botId: CAPTAIN_BOT_ID,
      projectId,
      title: " Dark mode ",
      brief: "Add a dark mode toggle to settings",
      workflowId: starter.id,
      featureId: "feature:dark-mode",
    });
    expect(started).toMatchObject({
      featureId: "feature:dark-mode",
      projectId,
      title: "Dark mode",
      workflowId: starter.id,
      workflowRevision: starter.revision,
      stage: starter.start,
    });
    expect(started.state).not.toBeNull();
    expect(yield* features.get(started.featureId)).toMatchObject({
      workflowId: starter.id,
      status: "open",
    });
    // Started, as features.start leaves it: the execution exists.
    expect(yield* executions.get(started.featureId)).not.toBeNull();

    // A retry with the same feature ID returns the same feature.
    const again = yield* botProjects.startFeature({
      botId: CAPTAIN_BOT_ID,
      projectId,
      title: "Dark mode",
      brief: "Add a dark mode toggle to settings",
      workflowId: starter.id,
      featureId: "feature:dark-mode",
    });
    expect(again.featureId).toBe(started.featureId);
    expect(yield* features.listByProject(projectId)).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("falls back to the bot's default workflow and asks for one without it", () =>
  Effect.gen(function* () {
    const starter = yield* seed;
    const botProjects = yield* BotProjects.BotProjects;
    const input = { botId: CAPTAIN_BOT_ID, projectId, title: "Docs", brief: "Write the docs" };

    const missing = yield* botProjects.startFeature(input).pipe(Effect.flip);
    expect(missing.message).toBe("Captain has no default workflow, so pass a workflowId");

    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE bots SET default_workflow_id = ${starter.id} WHERE id = ${CAPTAIN_BOT_ID}`;
    const started = yield* botProjects.startFeature(input);
    expect(started.workflowId).toBe(starter.id);
    expect(started.stage).toBe(starter.start);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses projects the bot doesn't own, and Scratch", () =>
  Effect.gen(function* () {
    const starter = yield* seed;
    const botProjects = yield* BotProjects.BotProjects;
    const bots = yield* BotStore.BotStore;
    const captain = (yield* bots.get(CAPTAIN_BOT_ID))!;
    yield* bots.insert({ ...captain, id: "bot-social", name: "Social", position: 1 });
    const socialProject = ProjectId.make("bot-projects-social");
    yield* seedCrewProject({
      projectId: socialProject,
      title: "Social",
      workspaceRoot: "/tmp/bot-projects-social",
      botId: "bot-social",
    });

    for (const target of [socialProject, scratchProjectId, ProjectId.make("missing")]) {
      const refused = yield* botProjects
        .startFeature({
          botId: CAPTAIN_BOT_ID,
          projectId: target,
          title: "Elsewhere",
          brief: "Not Captain's project",
          workflowId: starter.id,
        })
        .pipe(Effect.flip);
      expect(refused.message).toBe(`Captain doesn't own project ${target}`);
    }
    expect(yield* (yield* FeatureService).listByProject(socialProject)).toHaveLength(0);
  }).pipe(Effect.provide(layer)),
);
