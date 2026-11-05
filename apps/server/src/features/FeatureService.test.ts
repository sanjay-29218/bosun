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
  EPIC_WORKFLOW_ID,
  FEATURE_DELIVERY_WORKFLOW_ID,
  FEATURE_MANAGER_ROLE_ID,
  PROJECT_MANAGER_ROLE_ID,
  projectHeadquartersThreadId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type WorkflowSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as BotStore from "../bots/BotStore.ts";
import { CrewService } from "../crew/CrewService.ts";
import { CrewStore } from "../crew/CrewStore.ts";
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
import FeatureManagerMigration from "../persistence/Migrations/103_FeatureManager.ts";
import { retitleFeatureManagerLeads } from "./featureManagerTitles.ts";
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
    resolveHandle: () =>
      Effect.succeed({
        context: null,
        provider: {
          getIssue: ({ number }: { readonly number: number }) =>
            Effect.succeed({
              url: `https://github.com/owner/repo/issues/${number}`,
              number,
              title: "Dark mode toggle",
              state: "open",
              milestone: { number: 1, title: "v0.4" },
              subIssues: { completed: 1, total: 3 },
            }),
        },
      } as never),
  },
);

const withSystem = <E>(
  exercise: Effect.Effect<
    void,
    E,
    | FeatureService
    | CrewService
    | CrewStore
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

/** The text of each message a person, or another thread, sent to `threadId`. */
const userTexts = (threadId: ThreadId) =>
  OrchestrationEngineService.pipe(
    Effect.flatMap((engine) =>
      engine.getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] }),
    ),
    Effect.map(({ messages }) => messages.map((message) => message.text)),
  );

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

  effectIt.effect("keeps the thread that launched a feature to hear from its lead", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const launch = (requesterThreadId: ThreadId) =>
          features.launch({
            projectId,
            featureId: "launched-feature",
            title: "Dark mode",
            brief: "Add a dark mode toggle to settings",
            workspace: "local",
            requesterThreadId,
          });
        const first = yield* launch(ThreadId.make("bot-run:bot-hq:bot-captain"));
        // A retry from elsewhere starts nothing new and keeps who asked first.
        const retry = yield* launch(ThreadId.make("thread:someone-else"));
        expect(retry.leadThreadId).toBe(first.leadThreadId);
        expect(yield* features.requesterThreadId("launched-feature")).toBe(
          "bot-run:bot-hq:bot-captain",
        );
        const engine = yield* OrchestrationEngineService;
        const requesterOf = () =>
          engine
            .getThreadShell(first.leadThreadId)
            .pipe(Effect.map((shell) => shell?.feature?.requesterThreadId));
        expect(yield* requesterOf()).toBe("bot-run:bot-hq:bot-captain");
        yield* features.setIssue({
          id: "launched-feature",
          projectId,
          url: "https://github.com/owner/repo/issues/42",
        });
        expect(yield* requesterOf()).toBe("bot-run:bot-hq:bot-captain");
        // Its lead is caught up on after a restart.
        expect(yield* features.reportingLeads).toEqual([first.leadThreadId]);
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

  effectIt.effect(
    "a feature a linked environment's request starts runs on the workflow it brought",
    () =>
      withSystem(
        Effect.gen(function* () {
          const crew = yield* CrewService;
          const features = yield* FeatureService;
          const library = yield* crew.getWorkflow(FEATURE_DELIVERY_WORKFLOW_ID);
          expect(library?.revision).toBe(1);
          const role = (id: string, name: string) => ({
            id,
            name,
            instructions: `You are the laptop's ${name}.`,
            allowedTools: [],
            modelSelection,
            runtimeMode: "full-access" as const,
          });
          // Feature delivery as the laptop has it at revision 3, with a role this box lacks.
          const snapshot: WorkflowSnapshot = {
            workflow: {
              id: FEATURE_DELIVERY_WORKFLOW_ID,
              name: "Feature delivery v3",
              instructions: "Have the Security reviewer check the diff before the Builder pushes.",
              leadRoleId: "role:feature-manager",
              crewRoleIds: ["role:builder", "role:security-reviewer"],
              revision: 3,
            },
            roles: [
              role("role:feature-manager", "Feature manager"),
              role("role:builder", "Builder"),
              role("role:security-reviewer", "Security reviewer"),
            ],
          };
          // The Feature manager a link's request started here, which keeps that workflow.
          const manager = yield* crew.ensureFeatureManager(projectId);
          const requested = yield* crew.createRun({
            id: "link-task:dark-mode",
            memberId: manager.id,
            projectId,
            taskText: "Start a feature: dark mode.",
            workflow: { snapshot, here: "Box", from: "T3 Code · Laptop" },
          });
          const launch = (featureId: string, workflowId?: string) =>
            features.launch({
              projectId,
              featureId,
              title: "Dark mode",
              brief: "Add a dark mode toggle to settings",
              workspace: "local",
              requesterThreadId: requested.threadId,
              ...(workflowId === undefined ? {} : { workflowId }),
            });

          const started = yield* launch("linked-feature");
          expect(Object.keys(started.feature.crewAssignments).toSorted()).toEqual([
            "role:builder",
            "role:security-reviewer",
          ]);
          const reviewer = yield* (yield* CrewStore).getMember(
            started.feature.crewAssignments["role:security-reviewer"]!,
          );
          expect(reviewer).toMatchObject({
            name: "Security reviewer",
            instructions: "You are the laptop's Security reviewer.",
          });
          const opening = (yield* userTexts(started.leadThreadId))[0]!;
          expect(opening).toContain("You are the laptop's Feature manager.");
          expect(opening).toContain(
            "Workflow: Feature delivery v3\nHave the Security reviewer check the diff before the Builder pushes.",
          );
          expect(opening).toMatch(/^Crew: Builder, Security reviewer\. /m);

          // Naming the workflow it brought is the same; one this box lacks is refused.
          expect(
            (yield* launch("named-feature", "feature delivery v3")).feature.crewAssignments,
          ).toHaveProperty("role:security-reviewer");
          expect((yield* Effect.flip(launch("other-feature", "workflow:release"))).message).toBe(
            "Workflow workflow:release isn't on Box. This request from T3 Code · Laptop brought Feature delivery v3 (workflow:feature-delivery); leave workflowId out to run on it.",
          );
          // A feature this box's own threads start keeps using its library.
          const local = yield* features.launch({
            projectId,
            title: "Local work",
            brief: "Local work",
            workspace: "local",
            requesterThreadId: ThreadId.make("bot-run:bot-hq:bot-captain"),
          });
          expect(Object.keys(local.feature.crewAssignments)).not.toContain(
            "role:security-reviewer",
          );
        }),
      ),
  );

  effectIt.effect("starts child features that report back to their parent's lead once", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const parent = yield* features.launch({
          projectId,
          title: "Port to Mac",
          brief: "Port the app to a native Mac app",
          workspace: "local",
          workflowId: EPIC_WORKFLOW_ID,
        });
        expect((yield* userTexts(parent.leadThreadId))[0]).toMatch(/^Workflow: Epic$/m);
        // Agents name workflows loosely; an unknown one lists the real ones.
        const named = yield* features.launch({
          projectId,
          title: "Port to Linux",
          brief: "Port the app to Linux",
          workspace: "local",
          workflowId: "epic",
        });
        expect(named.feature.workflowId).toBe(EPIC_WORKFLOW_ID);
        const unknown = (yield* Effect.flip(
          features.launch({
            projectId,
            title: "Port to BeOS",
            brief: "Port the app to BeOS",
            workflowId: "lead-driven",
          }),
        )).message;
        expect(unknown).toContain("Workflow not found: lead-driven. Use one of:");
        expect(unknown).toContain("workflow:feature-delivery (Feature delivery)");
        expect(unknown).toContain("workflow:epic (Epic)");
        const child = yield* features.launch({
          projectId,
          title: "App shell",
          brief: "Build the app shell",
          workspace: "local",
          parentFeatureId: parent.feature.id,
        });
        expect(child.feature.parentFeatureId).toBe(parent.feature.id);
        const card = (yield* features.board(projectId)).find(
          (entry) => entry.featureId === child.feature.id,
        );
        expect(card?.parentFeatureId).toBe(parent.feature.id);
        const childShell = yield* (yield* OrchestrationEngineService).getThreadShell(
          child.leadThreadId,
        );
        expect(childShell?.feature?.parentFeatureId).toBe(parent.feature.id);
        // The child's lead knows whose work it is part of, and how to report back.
        const opening = (yield* userTexts(child.leadThreadId))[0]!;
        expect(opening).toContain(`Parent feature: "Port to Mac" (${parent.feature.id})`);
        // The report instruction comes last, after the brief.
        expect(opening.trimEnd()).toMatch(/call t3_feature_finish with a short summary\. .*\.$/);
        expect(
          yield* Effect.flip(
            features.launch({
              projectId,
              title: "Orphan",
              brief: "No parent",
              workspace: "local",
              parentFeatureId: "no-such-feature",
            }),
          ),
        ).toMatchObject({ message: "Parent feature not found" });

        // A retry of a feature ID from another parent, or on another base, is another request.
        const fixed = {
          projectId,
          featureId: "fixed-child",
          title: "Recording",
          brief: "Record the screen",
          workspace: "local" as const,
          parentFeatureId: parent.feature.id,
        };
        yield* features.launch(fixed);
        expect((yield* features.launch(fixed)).feature.id).toBe("fixed-child");
        const { parentFeatureId: _parent, ...orphan } = fixed;
        expect(yield* Effect.flip(features.launch(orphan))).toMatchObject({
          message: "Feature ID belongs to another request",
        });
        expect(
          yield* Effect.flip(
            features.launch({ ...fixed, workspace: "worktree", baseBranch: "bosun/other" }),
          ),
        ).toMatchObject({ message: "Feature ID belongs to another request" });

        // The project's checkout can't start from another branch.
        expect(
          yield* Effect.flip(
            features.launch({ ...fixed, featureId: "local-stacked", baseBranch: "bosun/shell" }),
          ),
        ).toMatchObject({
          message: "A feature in the project's checkout can't start from another branch",
        });

        // Only a feature's lead reports it done, and only to a parent.
        // Any feature's lead reports it finished; the board shows which run did.
        const cardOf = (id: string) =>
          features
            .board(projectId)
            .pipe(Effect.map((cards) => cards.find((card) => card.featureId === id)));
        yield* features.finishForThread(parent.leadThreadId, "Plan is ready");
        expect((yield* cardOf(parent.feature.id))?.report).toMatchObject({ outcome: "finished" });
        expect((yield* cardOf(parent.feature.id))?.report?.runId).toBeTruthy();
        expect(yield* userTexts(parent.leadThreadId)).toHaveLength(1);
        yield* features.finishForThread(child.leadThreadId, "Shell builds and launches");
        const reports = (yield* userTexts(parent.leadThreadId)).slice(1);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toContain(`Child feature finished: "App shell"`);
        expect(reports[0]).toContain("Shell builds and launches");

        // Closing a child that already reported doesn't report again; reopening resets that.
        yield* features.setStatus(child.feature.id, projectId, "closed");
        expect(yield* userTexts(parent.leadThreadId)).toHaveLength(2);
        yield* features.setStatus(child.feature.id, projectId, "open");
        expect((yield* cardOf(child.feature.id))?.report).toBeUndefined();
        yield* features.setStatus(child.feature.id, projectId, "closed");
        expect((yield* cardOf(child.feature.id))?.report).toEqual({
          outcome: "closed",
          runId: null,
        });
        const afterClose = (yield* userTexts(parent.leadThreadId)).slice(1);
        expect(afterClose).toHaveLength(2);
        expect(afterClose).toContainEqual(
          expect.stringContaining(`Child feature closed: "App shell"`),
        );

        // A crew member's thread in the child isn't its lead.
        const engine = yield* OrchestrationEngineService;
        const memberThread = ThreadId.make("child-builder-thread");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("child-builder:create"),
          threadId: memberThread,
          projectId,
          title: "Builder",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* engine.dispatch({
          type: "thread.crew-stage.set",
          commandId: CommandId.make("child-builder:tag"),
          threadId: memberThread,
          feature: { id: child.feature.id, title: "App shell", member: "Builder" },
        });
        expect(
          yield* Effect.flip(features.finishForThread(memberThread, "Built it")),
        ).toMatchObject({ message: "Only a feature's lead can report it done" });

        // A close whose report can't be delivered isn't marked reported.
        const sql = yield* SqlClient.SqlClient;
        const reportedAt = (id: string) =>
          sql<{ readonly at: string | null }>`
            SELECT reported_at AS at FROM features WHERE id = ${id}
          `.pipe(Effect.map((rows) => rows[0]?.at ?? null));
        yield* features.setStatus(child.feature.id, projectId, "open");
        yield* engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("parent-lead:archive"),
          threadId: parent.leadThreadId,
        });
        yield* features.setStatus(child.feature.id, projectId, "closed");
        expect(yield* reportedAt(child.feature.id)).toBeNull();
        expect((yield* userTexts(parent.leadThreadId)).slice(1)).toHaveLength(2);
        expect(
          yield* Effect.flip(features.finishForThread(child.leadThreadId, "Archived lead")),
        ).toMatchObject({ message: "The parent feature's lead thread is archived" });
        yield* engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("parent-lead:unarchive"),
          threadId: parent.leadThreadId,
        });
        // Closing it again retries the report, once.
        yield* features.setStatus(child.feature.id, projectId, "closed");
        yield* features.setStatus(child.feature.id, projectId, "closed");
        expect((yield* userTexts(parent.leadThreadId)).slice(1)).toHaveLength(3);
        expect(yield* reportedAt(child.feature.id)).not.toBeNull();

        // With its parent closed, a finished child is told nobody heard.
        yield* features.setStatus(parent.feature.id, projectId, "closed");
        expect(
          yield* Effect.flip(features.finishForThread(child.leadThreadId, "More work")),
        ).toMatchObject({
          message: "The parent feature is closed, so its lead wasn't told",
        });
        expect((yield* userTexts(parent.leadThreadId)).slice(1)).toHaveLength(3);
      }),
    ),
  );

  effectIt.effect("tells the parent's lead once when a child goes quiet without reporting", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const sql = yield* SqlClient.SqlClient;
        const parent = yield* features.launch({
          projectId,
          title: "Habit tracker",
          brief: "Build a habit tracker",
          workspace: "local",
          workflowId: EPIC_WORKFLOW_ID,
        });
        const engine = yield* OrchestrationEngineService;
        // Started, and its lead's first turn released past preparing, so its turn start is queued.
        const child = (title: string) =>
          features
            .launch({
              projectId,
              title,
              brief: `Build the ${title}`,
              workspace: "local",
              parentFeatureId: parent.feature.id,
            })
            .pipe(
              Effect.tap((started) =>
                engine
                  .streamStoredEventsFrom({
                    threadId: started.leadThreadId,
                    eventType: "run.updated",
                  })
                  .pipe(
                    Stream.filter(
                      (stored) =>
                        stored.event.type === "run.updated" &&
                        stored.event.payload.status !== "preparing",
                    ),
                    Stream.runHead,
                  ),
              ),
            );
        const notes = () => userTexts(parent.leadThreadId).pipe(Effect.map((all) => all.slice(1)));
        // Its turn ended, and the work queued to start it ran (no effect worker runs in tests).
        const setLeadRun = (threadId: ThreadId, status: string) =>
          Effect.all([
            sql`UPDATE orchestration_v2_projection_runs SET status = ${status} WHERE thread_id = ${threadId}`,
            sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded' WHERE thread_id = ${threadId}`,
          ]);

        // Its lead's turn ended without t3_feature_finish: the parent hears, once per turn.
        const storage = yield* child("storage");
        yield* setLeadRun(storage.leadThreadId, "completed");
        // A checkpoint still being captured after the turn settles without an event; it doesn't
        // hold the report back.
        yield* sql`
          INSERT INTO orchestration_v2_effect_outbox
            (effect_id, command_id, thread_id, effect_type, payload_json, status, attempt_count,
              available_at, created_at, updated_at)
          VALUES ('checkpoint-storage', 'checkpoint-storage', ${storage.leadThreadId},
            'checkpoint.capture', '{}', 'running', 0, '1970-01-01T00:00:00.000Z',
            '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
        `;
        yield* features.reportIfQuiet(storage.leadThreadId);
        yield* features.reportIfQuiet(storage.leadThreadId);
        const [stopped] = yield* notes();
        expect(yield* notes()).toHaveLength(1);
        expect(stopped).toMatch(/^Child feature stopped without reporting: "storage"/);
        expect(stopped).toContain("t3_thread_send");

        // A lead still working, or one that already reported this turn, sends nothing.
        const api = yield* child("API");
        yield* setLeadRun(api.leadThreadId, "running");
        yield* features.reportIfQuiet(api.leadThreadId);
        expect(yield* notes()).toHaveLength(1);
        yield* setLeadRun(api.leadThreadId, "completed");
        yield* features.finishForThread(api.leadThreadId, "API is in");
        yield* features.reportIfQuiet(api.leadThreadId);
        expect(yield* notes()).toHaveLength(2);
        // A report from an earlier run doesn't cover a later one that stopped without one.
        yield* sql`UPDATE features SET reported_run_id = 'an-earlier-run' WHERE id = ${api.feature.id}`;
        yield* setLeadRun(api.leadThreadId, "completed");
        yield* features.reportIfQuiet(api.leadThreadId);
        expect(yield* notes()).toHaveLength(3);

        // A message after its report, even steering the same run, withdraws "finished".
        const apiCard = () =>
          features
            .board(projectId)
            .pipe(Effect.map((cards) => cards.find((card) => card.featureId === api.feature.id)));
        yield* features.finishForThread(api.leadThreadId, "API is in, again");
        expect((yield* apiCard())?.report?.outcome).toBe("finished");
        yield* features.withdrawFinished(api.leadThreadId, "1969-12-31T00:00:00.000Z");
        expect((yield* apiCard())?.report?.outcome).toBe("finished");
        yield* features.withdrawFinished(api.leadThreadId, "2999-01-01T00:00:00.000Z");
        expect((yield* apiCard())?.report).toBeUndefined();

        // A child that went quiet while nobody watched is caught up on.
        const cli = yield* child("CLI");
        yield* setLeadRun(cli.leadThreadId, "completed");
        yield* features.reconcileChildren();
        yield* features.reportIfQuiet(cli.leadThreadId);
        expect(yield* notes()).toContainEqual(
          expect.stringMatching(/^Child feature stopped without reporting: "CLI"/),
        );

        // An interrupted turn says so, once nothing is queued to resume it.
        const page = yield* child("web page");
        yield* setLeadRun(page.leadThreadId, "cancelled");
        // A restart queues resuming the cut-short turn; until that runs, it isn't quiet.
        yield* sql`
          INSERT INTO orchestration_v2_effect_outbox
            (effect_id, command_id, thread_id, effect_type, payload_json, status, attempt_count,
              available_at, created_at, updated_at)
          VALUES ('resume-page', 'resume-page', ${page.leadThreadId}, 'provider-runtime.continue', '{}',
            'pending', 0, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z',
            '1970-01-01T00:00:00.000Z')
        `;
        const before = (yield* notes()).length;
        yield* features.reportIfQuiet(page.leadThreadId);
        expect(yield* notes()).toHaveLength(before);
        yield* setLeadRun(page.leadThreadId, "cancelled");
        yield* features.reportIfQuiet(page.leadThreadId);
        expect(yield* notes()).toContainEqual(
          expect.stringMatching(/^Child feature was interrupted: "web page"/),
        );
      }),
    ),
  );

  effectIt.effect(
    "lists a project's features with their branches, requester and pull request",
    () =>
      withSystem(
        Effect.gen(function* () {
          const features = yield* FeatureService;
          const sql = yield* SqlClient.SqlClient;
          const manager = projectHeadquartersThreadId(projectId);
          const parent = yield* features.launch({
            projectId,
            title: "Port to Mac",
            brief: "Port the app",
            requesterThreadId: manager,
          });
          const child = yield* features.launch({
            projectId,
            title: "Recording",
            brief: "Record the screen",
            baseBranch: "bosun/app-shell-123abc",
            parentFeatureId: parent.feature.id,
          });
          yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, '$.pullRequests', json(${JSON.stringify([
            {
              url: "https://github.com/owner/repo/pull/7",
              number: 7,
              source: "agent",
              snapshot: { state: "merged" },
            },
          ])}))
          WHERE thread_id = ${child.leadThreadId}
        `;
          yield* features.setStatus(parent.feature.id, projectId, "closed");

          expect(yield* features.list(projectId, { status: "open" })).toEqual([
            {
              featureId: child.feature.id,
              number: 2,
              title: "Recording",
              status: "open",
              leadThreadId: child.leadThreadId,
              branch: child.branch,
              baseBranch: "bosun/app-shell-123abc",
              parentFeatureId: parent.feature.id,
              issue: null,
              pullRequest: {
                url: "https://github.com/owner/repo/pull/7",
                number: 7,
                state: "merged",
              },
              requesterThreadId: null,
              requestId: null,
              report: null,
            },
          ]);
          const [closed] = yield* features.list(projectId, { status: "closed" });
          expect(closed).toMatchObject({
            featureId: parent.feature.id,
            requesterThreadId: manager,
            pullRequest: null,
          });
          expect(
            (yield* features.list(projectId, { parentFeatureId: parent.feature.id })).map(
              (feature) => feature.featureId,
            ),
          ).toEqual([child.feature.id]);
        }),
      ),
  );

  effectIt.effect("stacks a child on a branch that exists, and refuses one that doesn't", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const sql = yield* SqlClient.SqlClient;
        const parent = yield* features.launch({
          projectId,
          title: "Port to Mac",
          brief: "Port the app",
          workspace: "local",
        });
        const stacked = yield* features.launch({
          projectId,
          title: "Recording",
          brief: "Record the screen",
          baseBranch: "bosun/app-shell-123abc",
          parentFeatureId: parent.feature.id,
        });
        expect(stacked.branch).toMatch(/^bosun\/recording-/);
        const [run] = yield* sql<{ readonly baseRef: string | null }>`
          SELECT base_ref AS baseRef FROM crew_runs WHERE thread_id = ${stacked.leadThreadId}
        `;
        expect(run?.baseRef).toBe("bosun/app-shell-123abc");
        expect((yield* userTexts(stacked.leadThreadId))[0]).toContain(
          "Base branch: bosun/app-shell-123abc.",
        );
        // A feature that isn't a child keeps its lead's task free of its base.
        const standalone = yield* features.launch({
          projectId,
          title: "Settings",
          brief: "Add settings",
          baseBranch: "main",
        });
        expect((yield* userTexts(standalone.leadThreadId))[0]).not.toContain("Base branch:");
        expect(
          yield* Effect.flip(
            features.launch({
              projectId,
              title: "Editor",
              brief: "Edit recordings",
              baseBranch: "no-such-branch",
            }),
          ),
        ).toMatchObject({ message: "Branch no-such-branch doesn't exist in this project" });
      }),
    ),
  );

  effectIt.effect(
    "keeps delegating to a custom workflow's old manager by name after the rename",
    () =>
      withSystem(
        Effect.gen(function* () {
          const crew = yield* CrewService;
          const features = yield* FeatureService;
          const sql = yield* SqlClient.SqlClient;
          const workflow = yield* crew.createWorkflow({
            id: "workflow:managed",
            name: "Managed",
            instructions: "Plan it, then have the manager run it.",
            leadRoleId: "role:planner",
            crewRoleIds: [FEATURE_MANAGER_ROLE_ID],
          });
          yield* features.create({
            id: "managed-feature",
            projectId,
            title: "Managed",
            brief: "Run it",
            workspace: "local",
            workflowId: workflow.id,
          });
          // Back to the shape a feature started before the rename, and the Project manager, had.
          yield* sql`DELETE FROM roles WHERE id = 'role:project-manager'`;
          yield* sql`
          INSERT INTO roles (
            id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
            enabled, auto_create_for_feature, revision, created_at, updated_at
          )
          SELECT 'role:project-manager', 'Project manager', instructions, allowed_tools_json,
            model_selection_json, runtime_mode, enabled, auto_create_for_feature, revision,
            created_at, updated_at
          FROM roles WHERE id = ${FEATURE_MANAGER_ROLE_ID}
        `;
          yield* sql`
          UPDATE crew_members SET role_id = 'role:project-manager', name = 'Project manager'
          WHERE role_id = ${FEATURE_MANAGER_ROLE_ID}
        `;
          yield* sql`
          UPDATE workflows SET
            lead_role_id = replace(lead_role_id, ${FEATURE_MANAGER_ROLE_ID}, 'role:project-manager'),
            crew_role_ids_json = replace(crew_role_ids_json, ${FEATURE_MANAGER_ROLE_ID}, 'role:project-manager')
        `;
          yield* sql`DELETE FROM roles WHERE id = ${FEATURE_MANAGER_ROLE_ID}`;
          expect(
            (yield* features.crewMember("managed-feature", "role:project-manager"))?.name,
          ).toBe("Project manager");

          yield* FeatureManagerMigration;

          expect((yield* features.crewMember("managed-feature", "Project manager"))?.name).toBe(
            "Project manager",
          );
          expect(yield* features.crewMember("managed-feature", "role:project-manager")).toBeNull();
          expect((yield* crew.getWorkflow(workflow.id))?.crewRoleIds).toEqual([
            FEATURE_MANAGER_ROLE_ID,
          ]);
        }),
      ),
  );

  effectIt.effect("retitles open features' leads still called Project manager, once", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const engine = yield* OrchestrationEngineService;
        const sql = yield* SqlClient.SqlClient;
        const lead = Effect.fnUntraced(function* (id: string) {
          yield* features.create({ id, projectId, title: id, brief: "Brief", workspace: "local" });
          const { leadThreadId } = yield* features.start(id, projectId);
          expect((yield* engine.getThreadShell(leadThreadId))?.title).toBe("Feature manager");
          yield* engine.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`old-title:${id}`),
            threadId: leadThreadId,
            title: "Project manager",
          });
          return leadThreadId;
        });
        const open = yield* lead("open-feature");
        const closed = yield* lead("closed-feature");
        yield* sql`UPDATE features SET status = 'closed' WHERE id = 'closed-feature'`;

        yield* retitleFeatureManagerLeads();
        yield* retitleFeatureManagerLeads();

        expect((yield* engine.getThreadShell(open))?.title).toBe("Feature manager");
        expect((yield* engine.getThreadShell(closed))?.title).toBe("Project manager");
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

  effectIt.effect("links the issue a feature names as it is made, before its lead starts", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const engine = yield* OrchestrationEngineService;
        const started = yield* features.launch({
          projectId,
          title: "Dark mode",
          brief: "Add dark mode",
          workspace: "local",
          issue: "#42",
        });
        expect(started.feature.issue).toMatchObject({ number: 42, title: "Dark mode toggle" });
        // The lead's first tag already carries it, with nothing left to arrive later.
        const shell = yield* engine.getThreadShell(started.leadThreadId);
        expect(shell?.feature?.issue).toMatchObject({ number: 42 });
        expect((yield* features.get(started.feature.id))?.issue).toMatchObject({ number: 42 });
        // An issue that can't be read leaves no feature behind.
        const before = (yield* features.listByProject(projectId)).length;
        expect(
          (yield* Effect.flip(
            features.launch({
              projectId,
              title: "Bad",
              brief: "Bad",
              workspace: "local",
              issue: "https://github.com/owner/repo/pull/7",
            }),
          )).message,
        ).toBe("Paste a link to an issue");
        expect(yield* features.listByProject(projectId)).toHaveLength(before);
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

        // A delegated task's thread links its own issue, apart from any feature's.
        const threadIssue = () =>
          engine.getThreadShell(leadThreadId).pipe(Effect.map((shell) => shell!.issue ?? null));
        expect(yield* features.setThreadIssue(leadThreadId, "#42")).toEqual(issue);
        expect(yield* threadIssue()).toEqual(issue);
        expect(yield* tagOf()).toEqual({ id: target.id, title: "Dark mode" });
        const linear = {
          url: "https://linear.app/acme/issue/LIN-123",
          key: "LIN-123",
          number: 123,
          title: "Fix login",
          state: "open",
          milestone: null,
          subIssues: null,
        };
        expect(
          yield* features.setThreadIssue(
            leadThreadId,
            "https://linear.app/acme/issue/lin-123/fix-login",
          ),
        ).toEqual(linear);
        expect(yield* threadIssue()).toEqual(linear);
        expect(yield* features.resolveIssue(projectId, " LIN-123 ")).toEqual({
          ...linear,
          url: "",
          title: "",
        });
        expect(yield* features.setThreadIssue(leadThreadId, null)).toBeNull();
        expect(yield* threadIssue()).toBeNull();
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

  effectIt.effect(
    "keeps a project's manager pinned in its project, following its settings until reset",
    () =>
      withSystem(
        Effect.gen(function* () {
          const crew = yield* CrewService;
          const engine = yield* OrchestrationEngineService;
          const crewStore = yield* CrewStore;
          const before = yield* crew.projectManagerSettings(projectId);
          expect(before).toMatchObject({ revision: 0, customized: false, threadId: null });
          expect(before.instructions).toContain("You manage one project");

          const run = yield* crew.ensureProjectManager(projectId);
          expect(run.threadId).toBe(projectHeadquartersThreadId(projectId));
          expect(yield* crew.ensureProjectManager(projectId)).toEqual(run);
          const shell = () => engine.getThreadShell(run.threadId);
          // It lives in its project, in the project's checkout.
          expect(yield* shell()).toMatchObject({ projectId, branch: null, worktreePath: null });
          expect((yield* shell())?.pinnedAt).toBeTruthy();
          expect(
            (yield* engine
              .dispatch({
                type: "thread.delete",
                commandId: CommandId.make("test:delete-pm"),
                threadId: run.threadId,
              })
              .pipe(Effect.flip))._tag,
          ).toBe("OrchestratorHeadquartersThreadDeleteError");
          yield* engine.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("test:archive-pm"),
            threadId: run.threadId,
          });
          yield* crew.ensureProjectManager(projectId);
          expect((yield* shell())?.archivedAt).toBeNull();

          const created = yield* crew.projectManagerSettings(projectId);
          expect(created).toMatchObject({ revision: 1, threadId: run.threadId });
          const runtimeMode =
            created.runtimeMode === "full-access" ? "approval-required" : "full-access";
          const saved = yield* crew.updateProjectManager({
            projectId,
            instructions: "Manage it my way.",
            allowedTools: ["worktree"],
            modelSelection: created.modelSelection,
            runtimeMode,
            longConversation: "new-session",
            expectedRevision: created.revision,
          });
          expect(saved).toMatchObject({
            customized: true,
            revision: 2,
            longConversation: "new-session",
          });
          // The open thread follows: its mode now, its grants on the next tool call.
          expect((yield* shell())?.runtimeMode).toBe(runtimeMode);
          expect((yield* crewStore.getRun(run.id))?.allowedTools).toEqual(["worktree"]);
          expect(
            (yield* crew
              .updateProjectManager({ ...saved, instructions: "Stale", expectedRevision: 1 })
              .pipe(Effect.flip)).message,
          ).toContain("reload");

          // A role edit leaves a customized manager alone, until it is reset to the role.
          const role = (yield* crewStore.getRole(PROJECT_MANAGER_ROLE_ID))!;
          yield* crew.updateRole({
            ...role,
            instructions: "Manage, edited.",
            expectedRevision: role.revision,
          });
          expect((yield* crew.projectManagerSettings(projectId)).instructions).toBe(
            "Manage it my way.",
          );
          const reset = yield* crew.resetProjectManager({ projectId, expectedRevision: 2 });
          expect(reset).toMatchObject({
            customized: false,
            revision: 3,
            allowedTools: [],
            runtimeMode: role.runtimeMode,
            longConversation: "compact",
          });
          expect(reset.instructions).toBe(`Manage, edited.\n\nYour project is ${projectId}.`);
          expect((yield* shell())?.runtimeMode).toBe(role.runtimeMode);
        }),
      ),
  );

  effectIt.effect("keeps the Project manager out of workflows", () =>
    withSystem(
      Effect.gen(function* () {
        const crew = yield* CrewService;
        const workflow = {
          id: "workflow:managed-by-pm",
          name: "Managed",
          instructions: "Run it.",
          leadRoleId: PROJECT_MANAGER_ROLE_ID,
          crewRoleIds: [],
        };
        expect((yield* crew.createWorkflow(workflow).pipe(Effect.flip)).message).toContain(
          "can't lead a workflow",
        );
        expect(
          (yield* crew
            .createWorkflow({
              ...workflow,
              leadRoleId: FEATURE_MANAGER_ROLE_ID,
              crewRoleIds: [PROJECT_MANAGER_ROLE_ID],
            })
            .pipe(Effect.flip)).message,
        ).toContain("join its crew");
        const delivery = (yield* crew.getWorkflow(FEATURE_DELIVERY_WORKFLOW_ID))!;
        expect(delivery.crewRoleIds).not.toContain(PROJECT_MANAGER_ROLE_ID);
        expect(
          (yield* crew
            .updateWorkflow({
              ...delivery,
              crewRoleIds: [...delivery.crewRoleIds, PROJECT_MANAGER_ROLE_ID],
              expectedRevision: delivery.revision,
            })
            .pipe(Effect.flip))._tag,
        ).toBe("CrewValidationError");
      }),
    ),
  );
});
