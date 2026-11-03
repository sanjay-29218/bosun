// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  CAPTAIN_BOT_ID,
  CommandId,
  FEATURE_DELIVERY_WORKFLOW_ID,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import * as BotStore from "../bots/BotStore.ts";
import { CrewService } from "../crew/CrewService.ts";
import { CrewRuntimeLive } from "../crew/runtimeLayer.ts";
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
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import { FeatureService, FeatureServiceLive, generateFeatureTitle } from "./FeatureService.ts";
import { FeatureWorkspacesLive } from "./FeatureWorkspaces.ts";
import { firstIssueRef } from "./featureIssue.ts";

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

const withSystem = <E>(
  exercise: Effect.Effect<
    void,
    E,
    | FeatureService
    | CrewService
    | OrchestrationEngineService
    | BotStore.BotStore
    | SqlClient.SqlClient
    | TextGeneration.TextGeneration
    | ProjectStore.ProjectStoreV2
    | ServerSettingsService
  >,
) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "feature-integration-")),
    );
    const orchestration = OrchestrationLayerLive;
    const layer = FeatureServiceLive.pipe(
      Layer.provideMerge(FeatureWorkspacesLive),
      Layer.provideMerge(CrewRuntimeLive.pipe(Layer.provide(orchestration))),
      Layer.provideMerge(orchestration),
      // Stateless over SQLite, so seeded threads read back through the orchestrator.
      Layer.provideMerge(ProjectionStore.layer),
      Layer.provideMerge(SqlitePersistence.layerFromPath(NodePath.join(directory, "state.sqlite"))),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "feature-test-" })),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(TextGenerationPending),
      Layer.provideMerge(SourceControlIssues),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(
        DocumentText.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, EffectNodeCrypto.layer)),
        ),
      ),
      // Bots keep their headquarters in the Scratch project.
      Layer.provideMerge(
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/unused",
          ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      yield* seedCrewProject({ projectId, title: "Feature project", workspaceRoot: directory });
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

describe("feature lead and crew", () => {
  effectIt.effect("starts its lead with the brief once, naming the crew it can delegate to", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const engine = yield* OrchestrationEngineService;
        const target = { id: "lead-feature", projectId };
        const feature = yield* features.create({
          ...target,
          title: "Dark mode",
          brief: "Add a dark mode toggle to settings",
          workspace: "local",
        });
        // Every role that joins features gets a member; the manager leads instead.
        expect(Object.keys(feature.crewAssignments).toSorted()).toEqual([
          "role:builder",
          "role:designer",
          "role:planner",
          "role:qa-tester",
          "role:reviewer",
        ]);
        expect((yield* features.board(projectId))[0]?.leadThreadId).toBeNull();

        const started = yield* features.start(target.id, projectId);
        // Starting again, as a retry does, returns the same lead, even one started on older text.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE crew_runs SET task_text = 'Older lead task' WHERE thread_id = ${started.leadThreadId}`;
        expect((yield* features.start(target.id, projectId)).leadThreadId).toBe(
          started.leadThreadId,
        );
        const shell = (yield* engine.getThreadShell(started.leadThreadId))!;
        expect(shell.feature).toEqual({ id: target.id, title: "Dark mode" });
        const { messages } = yield* engine.getThreadRecords(started.leadThreadId, ["messages"], {
          messageRoles: ["user"],
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]!.text).toContain("Add a dark mode toggle to settings");
        expect(messages[0]!.text).toMatch(/^Workflow: Feature delivery$/m);
        expect(messages[0]!.text).toMatch(/^Crew: .*Planner/m);
        expect((yield* features.board(projectId))[0]?.leadThreadId).toBe(started.leadThreadId);
      }),
    ),
  );

  effectIt.effect("runs a feature on its workflow's lead, crew and instructions", () =>
    withSystem(
      Effect.gen(function* () {
        const crew = yield* CrewService;
        const features = yield* FeatureService;
        const engine = yield* OrchestrationEngineService;
        const role = (id: string, name: string) =>
          crew.createRole({
            id,
            name,
            instructions: `You are the ${name}.`,
            modelSelection,
            runtimeMode: "full-access",
          });
        yield* role("role:content-lead", "Content lead");
        yield* role("role:copywriter", "Copywriter");
        const workflow = yield* crew.createWorkflow({
          id: "workflow:social",
          name: "Social media",
          instructions: "Draft the week's posts, then ask the person to approve them.",
          leadRoleId: "role:content-lead",
          crewRoleIds: ["role:copywriter", "role:content-lead", "role:copywriter"],
        });
        // The lead leads; it isn't on its own crew.
        expect(workflow.crewRoleIds).toEqual(["role:copywriter"]);
        const input = {
          id: "social-feature",
          projectId,
          title: "Launch week",
          brief: "Posts for the launch",
          workspace: "local" as const,
          workflowId: workflow.id,
        };
        const feature = yield* features.create(input);
        expect(feature.workflowId).toBe(workflow.id);
        expect(Object.keys(feature.crewAssignments)).toEqual(["role:copywriter"]);
        // The same feature ID on another workflow is another request.
        const { workflowId: _workflowId, ...onDefault } = input;
        expect((yield* Effect.flip(features.create(onDefault))).message).toBe(
          "Feature ID belongs to another request",
        );

        const { leadThreadId } = yield* features.start(input.id, projectId);
        expect((yield* engine.getThreadShell(leadThreadId))?.title).toBe("Content lead");
        const { messages } = yield* engine.getThreadRecords(leadThreadId, ["messages"], {
          messageRoles: ["user"],
        });
        const text = messages[0]!.text;
        expect(text).toContain("You are the Content lead.");
        expect(text).toContain(
          "Workflow: Social media\nDraft the week's posts, then ask the person to approve them.",
        );
        expect(text).toMatch(/^Crew: Copywriter\. /m);
        expect((yield* features.board(projectId))[0]?.leadThreadId).toBe(leadThreadId);
        expect(yield* Effect.flip(crew.deleteWorkflow(FEATURE_DELIVERY_WORKFLOW_ID))).toMatchObject(
          { message: "Feature delivery can be edited but not deleted" },
        );
      }),
    ),
  );

  effectIt.effect("finds a crew member by name or role for its lead, and no one else", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        yield* features.create({
          id: "crew-feature",
          projectId,
          title: "Crew",
          brief: "Exercise the crew",
          workspace: "local",
        });
        const planner = yield* features.crewMember("crew-feature", " planner ");
        expect(planner).toMatchObject({ name: "Planner", modelSelection });
        expect(planner?.instructions).toContain("You are the Planner on a feature's crew.");
        expect((yield* features.crewMember("crew-feature", "role:builder"))?.name).toBe("Builder");
        expect(yield* features.crewMember("crew-feature", "Stylist")).toBeNull();
        expect(yield* features.crewMember("no-such-feature", "Planner")).toBeNull();
        expect((yield* features.crewMemberNames("crew-feature")).toSorted()).toEqual([
          "Builder",
          "Designer",
          "Planner",
          "QA Tester",
          "Reviewer",
        ]);
      }),
    ),
  );

  effectIt.effect("swaps a composer feature's stand-in title for a generated one", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const engine = yield* OrchestrationEngineService;
        const standIn = "Um so let's add uh a dark mode toggle";
        const input = {
          id: "titled-feature",
          projectId,
          title: standIn,
          brief: `${standIn} to the settings page`,
          workspace: "local" as const,
          autoTitle: true,
        };
        const feature = yield* features.create(input);
        expect(feature).not.toHaveProperty("autoTitle");
        // A retry may send a different stand-in once the title was replaced.
        expect(yield* features.create({ ...input, title: "Dark mode" })).toEqual(feature);
        const { leadThreadId: managerThreadId } = yield* features.start(input.id, projectId);
        // A thread named after the feature's stand-in follows its new title.
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
        const engine = yield* OrchestrationEngineService;
        const target = { id: "issue-feature", projectId };
        yield* features.create({
          ...target,
          title: "Dark mode",
          brief: "Add dark mode",
          workspace: "local",
        });
        const { leadThreadId } = yield* features.start(target.id, projectId);
        const tagOf = () =>
          engine.getThreadShell(leadThreadId).pipe(Effect.map((shell) => shell!.feature));

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

  effectIt.effect("links a project's ticket by its T-number, and only that project's", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const sql = yield* SqlClient.SqlClient;
        const target = { id: "ticket-feature", projectId };
        yield* features.create({
          ...target,
          title: "Board",
          brief: "Sketch the board",
          workspace: "local",
        });
        yield* sql`
          INSERT INTO tickets (id, project_id, number, title, description, state, created_at, updated_at)
          VALUES ('ticket:a', ${projectId}, 7, 'Sketch the board', '', 'open', '2026-10-28', '2026-10-28')
        `;

        const linked = yield* features.setIssue({ ...target, url: " t-7 " });
        expect(linked.issue).toEqual({
          url: "",
          ticketId: "ticket:a",
          number: 7,
          title: "Sketch the board",
          state: "open",
          milestone: null,
          subIssues: null,
        });

        const missing = yield* Effect.flip(features.setIssue({ ...target, url: "T-8" }));
        expect(missing.message).toBe("No ticket T-8 in this project");
        expect(firstIssueRef("Sketch it\n\nTicket T-7")).toBe("T-7");
        expect(firstIssueRef("Fix T-7 later")).toBeNull();
      }),
    ),
  );

  effectIt.effect(
    "keeps a headquarters undeletable, restores it once archived, and follows the bot's settings",
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

          const refused = yield* engine
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.make("test:delete-hq"),
              threadId: headquarters.threadId,
            })
            .pipe(Effect.flip);
          expect(refused._tag).toBe("OrchestratorHeadquartersThreadDeleteError");
          const kept = yield* shell();
          expect(kept!.deletedAt).toBeNull();
          expect(kept!.pinnedAt).toBeTruthy();

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
});
