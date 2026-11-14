// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  botHeadquartersThreadId,
  CommandId,
  EPIC_WORKFLOW_ID,
  MessageId,
  FEATURE_DELIVERY_WORKFLOW_ID,
  FEATURE_MANAGER_ROLE_ID,
  projectHeadquartersThreadId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  LEGACY_TOOLS_MESSAGE,
  ThreadId,
  type ServerProvider,
  type WorkflowSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as BotStore from "../bots/BotStore.ts";
import { CrewService } from "../crew/CrewService.ts";
import { CrewStore } from "../crew/CrewStore.ts";
import { StandingBriefingLive } from "../crew/StandingBriefing.ts";
import { CrewRuntimeLive } from "../crew/runtimeLayer.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  CrewTestOrchestration as OrchestrationLayerLive,
  makeCrewTestOrchestration,
  seedCrewProject,
} from "../crew/CrewRuntime.testkit.ts";
import { OrchestratorV2 as OrchestrationEngineService } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnBriefing from "../orchestration-v2/TurnBriefing.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import { FeatureService, FeatureServiceLive, generateFeatureTitle } from "./FeatureService.ts";
import { FeatureWorkspacesLive } from "./FeatureWorkspaces.ts";
import * as NoticeInbox from "./NoticeInbox.ts";
import * as FeatureReportReactor from "./FeatureReportReactor.ts";
import FeatureManagerMigration from "../persistence/Migrations/103_FeatureManager.ts";
import { retitleFeatureManagerLeads } from "./featureManagerTitles.ts";
import { firstIssueRef } from "./featureIssue.ts";

const CAPTAIN_ID = "bot-ops";

const projectId = ProjectId.make("workflow-feature-project");
const scratchProjectId = ProjectId.make("workflow-feature-scratch");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
/** A signed-in Codex, the only provider: what a fresh install's new threads run on. */
const readyCodex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-01T00:00:00.000Z",
  models: [
    { slug: "gpt-5.4", name: "GPT-5.4", isDefault: true, isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};
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
            parent: 40,
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
              parent: 40,
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
    | NoticeInbox.NoticeInbox
    | ProjectionStore.ProjectionStoreV2
  >,
  orchestration: typeof OrchestrationLayerLive = OrchestrationLayerLive,
) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "feature-integration-")),
    );
    const layer = FeatureServiceLive.pipe(
      Layer.provideMerge(NoticeInbox.layer),
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
        const first = yield* launch(ThreadId.make("bot-run:bot-hq:bot-ops"));
        // A retry from elsewhere starts nothing new and keeps who asked first.
        const retry = yield* launch(ThreadId.make("thread:someone-else"));
        expect(retry.leadThreadId).toBe(first.leadThreadId);
        expect(yield* features.requesterThreadId("launched-feature")).toBe(
          "bot-run:bot-hq:bot-ops",
        );
        const engine = yield* OrchestrationEngineService;
        const requesterOf = () =>
          engine
            .getThreadShell(first.leadThreadId)
            .pipe(Effect.map((shell) => shell?.feature?.requesterThreadId));
        expect(yield* requesterOf()).toBe("bot-run:bot-hq:bot-ops");
        yield* features.setIssue({
          id: "launched-feature",
          projectId,
          url: "https://github.com/owner/repo/issues/42",
        });
        expect(yield* requesterOf()).toBe("bot-run:bot-hq:bot-ops");
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
        // The lead reads as the feature, whatever its role.
        expect((yield* engine.getThreadShell(leadThreadId))?.title).toBe("Launch week");
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
            withheldTools: [],
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
            requesterThreadId: ThreadId.make("bot-run:bot-hq:bot-ops"),
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

  effectIt.effect("tells whoever started a feature when a stage ends, at once if it is busy", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const engine = yield* OrchestrationEngineService;
        const inbox = yield* NoticeInbox.NoticeInbox;
        const sql = yield* SqlClient.SqlClient;
        const hq = ThreadId.make("thread:hq");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("hq:create"),
          threadId: hq,
          projectId,
          title: "HQ",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
        });
        const launch = (title: string) =>
          features
            .launch({
              projectId,
              title,
              brief: `Build ${title}`,
              workspace: "local",
              requesterThreadId: hq,
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
        const setRun = (threadId: ThreadId, status: string) =>
          Effect.all([
            sql`UPDATE orchestration_v2_projection_runs SET status = ${status} WHERE thread_id = ${threadId}`,
            sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded' WHERE thread_id = ${threadId}`,
          ]);
        const fakeRun = (runId: string, threadId: ThreadId, status: string) => sql`
          INSERT INTO orchestration_v2_projection_runs
            (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${runId}, ${threadId}, 99, 'codex', ${status}, '2026-11-05T00:00:00.000Z', '{}')
          ON CONFLICT (run_id) DO UPDATE SET status = excluded.status
        `;
        const held = sql<{ readonly key: string }>`
          SELECT key FROM notice_inbox WHERE thread_id = ${hq} AND dropped_at IS NULL
        `.pipe(Effect.map((rows) => rows.map((row) => row.key)));

        // HQ is busy with a turn of its own.
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("hq:ask"),
          threadId: hq,
          messageId: MessageId.make("message:hq:ask"),
          text: "Ship exports and charts",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* setRun(hq, "running");
        const csv = yield* launch("CSV export");
        const pdf = yield* launch("PDF export");
        const charts = yield* launch("Charts");

        // The lead stops while its Builder, a thread it started itself, still works: progress.
        const builder = ThreadId.make("thread:csv-builder");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("csv-builder:create"),
          threadId: builder,
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
          commandId: CommandId.make("csv-builder:tag"),
          threadId: builder,
          feature: { id: csv.feature.id, title: "CSV export", member: "Builder" },
        });
        yield* fakeRun("run:builder", builder, "running");
        for (let stop = 0; stop < 5; stop++) {
          yield* setRun(csv.leadThreadId, "completed");
          yield* features.reportIfQuiet(csv.leadThreadId);
        }
        expect(yield* held).toEqual([]);
        // It finishes once, and stopping after that reports nothing more.
        yield* features.finishForThread(csv.leadThreadId, "CSV export is merged");
        yield* fakeRun("run:builder", builder, "completed");
        yield* features.reportIfQuiet(csv.leadThreadId);

        // Leads that stop with nothing left running report how their turn ended.
        yield* setRun(pdf.leadThreadId, "completed");
        yield* setRun(charts.leadThreadId, "failed");
        yield* features.reconcileChildren();
        yield* features.reportIfQuiet(pdf.leadThreadId);
        expect(yield* held).toHaveLength(3);
        expect(yield* userTexts(hq)).toEqual(["Ship exports and charts"]);

        // HQ's turn ends: one message carries all three.
        yield* setRun(hq, "completed");
        yield* inbox.flush(hq);
        yield* inbox.flush(hq);
        const [, digest, ...rest] = yield* userTexts(hq);
        expect(rest).toEqual([]);
        expect(digest).toMatch(/^3 updates arrived while you were busy:/);
        // Headlines only: the lead's own words never travel up.
        expect(digest).toContain(
          `Feature "CSV export" (lead thread ${csv.leadThreadId}) finished: CSV export is merged`,
        );
        expect(digest).toContain(
          `Feature "PDF export" (lead thread ${pdf.leadThreadId}) needs you: its lead is asking in thread ${pdf.leadThreadId}.`,
        );
        expect(digest).toContain(
          `Feature "Charts" (lead thread ${charts.leadThreadId}) failed: its lead's turn ended with an error.`,
        );

        // Stopping again before the person answers is the same open question: no second line.
        yield* setRun(pdf.leadThreadId, "completed");
        yield* features.reportIfQuiet(pdf.leadThreadId);
        yield* inbox.flush(hq);
        expect(yield* userTexts(hq)).toHaveLength(2);
        // Once the person writes to the lead, its next quiet stop is a new question.
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("pdf:answer"),
          threadId: pdf.leadThreadId,
          messageId: MessageId.make("message:pdf:answer"),
          text: "Use A4",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* setRun(pdf.leadThreadId, "completed");
        yield* features.reportIfQuiet(pdf.leadThreadId);
        yield* inbox.flush(hq);
        const [, , again, ...none] = yield* userTexts(hq);
        expect(none).toEqual([]);
        expect(again).toContain(`Feature "PDF export" (lead thread ${pdf.leadThreadId}) needs you`);
        // The board reads only the finish.
        const reports = (yield* features.board(projectId)).map((card) => [
          card.title,
          card.report?.outcome,
        ]);
        expect(reports).toEqual(
          expect.arrayContaining([
            ["CSV export", "finished"],
            ["PDF export", undefined],
            ["Charts", undefined],
          ]),
        );
      }),
    ),
  );

  effectIt.effect(
    "catches up on stops since the upgrade and open questions at start-up, in one message",
    () =>
      withSystem(
        Effect.gen(function* () {
          const features = yield* FeatureService;
          const engine = yield* OrchestrationEngineService;
          const sql = yield* SqlClient.SqlClient;
          const hq = ThreadId.make("thread:hq-upgraded");
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("hq-upgraded:create"),
            threadId: hq,
            projectId,
            title: "HQ",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "agent",
            creationSource: "mcp",
          });
          const launch = (title: string) =>
            features
              .launch({
                projectId,
                title,
                brief: `Build ${title}`,
                workspace: "local",
                requesterThreadId: hq,
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
          const stop = (threadId: ThreadId) =>
            Effect.all([
              sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE thread_id = ${threadId}`,
              sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded' WHERE thread_id = ${threadId}`,
            ]);

          // A lead that stopped before the upgrade, while the old reporter skipped it.
          const before = yield* launch("Paused export");
          yield* stop(before.leadThreadId);
          yield* sql`UPDATE notice_inbox_cutoff SET sequence = (SELECT MAX(sequence) FROM orchestration_events)`;
          // A feature in flight at the upgrade: its lead stopped before it, its Builder after.
          const inFlight = yield* launch("Charts");
          const builder = ThreadId.make("thread:charts-builder");
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("charts-builder:create"),
            threadId: builder,
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
            commandId: CommandId.make("charts-builder:tag"),
            threadId: builder,
            feature: { id: inFlight.feature.id, title: "Charts", member: "Builder" },
          });
          yield* stop(inFlight.leadThreadId);
          yield* sql`UPDATE notice_inbox_cutoff SET sequence = (SELECT MAX(sequence) FROM orchestration_events)`;
          yield* engine.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("charts-builder:task"),
            threadId: builder,
            messageId: MessageId.make("message:charts-builder:task"),
            text: "Build the charts",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* stop(builder);
          // Two leads that stopped after it, while the server was down.
          const csv = yield* launch("CSV export");
          const pdf = yield* launch("PDF export");
          yield* stop(csv.leadThreadId);
          yield* stop(pdf.leadThreadId);
          // And one that asked the person something.
          const asking = yield* launch("Dark mode");
          yield* sql`
            INSERT INTO orchestration_v2_projection_runtime_requests
              (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
            VALUES ('request:dark', ${asking.leadThreadId}, 'node:dark', 'user_input', 'pending',
              '1970-01-01T00:00:00.000Z', ${JSON.stringify({
                id: "request:dark",
                nodeId: "node:dark",
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "user_input",
                status: "pending",
                responseCapability: { type: "message" },
                createdAt: "1970-01-01T00:00:00.000Z",
                resolvedAt: null,
              })})
          `;

          const catchUp = FeatureReportReactor.catchUpAtStartup().pipe(
            Effect.provide(FeatureReportReactor.layer),
          );
          yield* catchUp;
          const [digest, ...rest] = yield* userTexts(hq);
          expect(rest).toEqual([]);
          expect(digest).toMatch(/^4 updates arrived while you were busy:/);
          expect(digest).toContain('Feature "CSV export"');
          expect(digest).toContain('Feature "PDF export"');
          expect(digest).toContain('Feature "Charts"');
          expect(digest).toContain('Feature "Dark mode" (lead thread');
          expect(digest).toContain("needs you: its lead is asking");
          expect(digest).not.toContain("Paused export");

          // Catching up again reports nothing twice.
          yield* catchUp;
          const charts = yield* sql`
            SELECT key FROM notice_inbox WHERE subject = ${inFlight.feature.id}
          `;
          expect(charts).toHaveLength(1);
        }),
      ),
  );

  effectIt.effect("doesn't count a silent /compact after the upgrade as the feature working", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const engine = yield* OrchestrationEngineService;
        const sql = yield* SqlClient.SqlClient;
        const hq = ThreadId.make("thread:hq-compacting");
        const createThread = (threadId: ThreadId, title: string) =>
          engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${threadId}:create`),
            threadId,
            projectId,
            title,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "agent",
            creationSource: "mcp",
          });
        yield* createThread(hq, "HQ");
        const launch = (title: string) =>
          features
            .launch({
              projectId,
              title,
              brief: `Build ${title}`,
              workspace: "local",
              requesterThreadId: hq,
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
        const stop = (threadId: ThreadId) =>
          Effect.all([
            sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE thread_id = ${threadId}`,
            sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded' WHERE thread_id = ${threadId}`,
          ]);
        const send = (threadId: ThreadId, key: string, text: string, compaction: boolean) =>
          engine.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(key),
            threadId,
            messageId: MessageId.make(`message:${key}`),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: compaction ? "server" : "mcp",
            ...(compaction ? { idleCompaction: "beforeCacheExpires" as const } : {}),
          });

        // Two features whose leads stopped before the upgrade; one has a Builder thread.
        const csv = yield* launch("CSV export");
        const pdf = yield* launch("PDF export");
        const builder = ThreadId.make("thread:pdf-builder");
        yield* createThread(builder, "Builder");
        yield* engine.dispatch({
          type: "thread.crew-stage.set",
          commandId: CommandId.make("pdf-builder:tag"),
          threadId: builder,
          feature: { id: pdf.feature.id, title: "PDF export", member: "Builder" },
        });
        yield* stop(csv.leadThreadId);
        yield* stop(pdf.leadThreadId);
        yield* sql`UPDATE notice_inbox_cutoff SET sequence = (SELECT MAX(sequence) FROM orchestration_events)`;

        // After it, each only compacts: the lead of one, the Builder of the other.
        yield* send(csv.leadThreadId, "csv-lead:compact", "/compact", true);
        yield* stop(csv.leadThreadId);
        yield* send(builder, "pdf-builder:compact", "/compact", true);
        yield* stop(builder);
        yield* features.reconcileChildren();
        const keys = sql<{ readonly key: string }>`SELECT key FROM notice_inbox`.pipe(
          Effect.map((rows) => rows.map((row) => row.key)),
        );
        expect(yield* keys).toEqual([]);

        // Real work afterwards does count.
        yield* send(csv.leadThreadId, "csv-lead:resume", "Carry on with the export", false);
        yield* stop(csv.leadThreadId);
        yield* features.reconcileChildren();
        expect(yield* keys).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect("sends a lone notice the orchestrator rejected again under a new command", () =>
    withSystem(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const inbox = yield* NoticeInbox.NoticeInbox;
        const sql = yield* SqlClient.SqlClient;
        const hq = ThreadId.make("thread:hq-rejecting");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("hq-rejecting:create"),
          threadId: hq,
          projectId,
          title: "HQ",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
        });
        // A run the projection can't read makes the thread's commands fail, and they're rejected.
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs
            (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES ('run:unreadable', ${hq}, 1, 'codex', 'completed', '2026-11-05T00:00:00.000Z', '{}')
        `;
        yield* inbox.post({ threadId: hq, key: "project-merge:web:12", text: "PR #12 merged" });
        const receipts = yield* sql<{ readonly status: string }>`
          SELECT status FROM orchestration_command_receipts
          WHERE command_id LIKE 'notice-digest:%' AND aggregate_id = ${hq}
        `;
        expect(receipts.map((receipt) => receipt.status)).toEqual(["rejected"]);
        expect(yield* userTexts(hq)).toEqual([]);

        yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = 'run:unreadable'`;
        yield* inbox.flush(hq);
        expect(yield* userTexts(hq)).toEqual(["PR #12 merged"]);
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
            id, name, instructions, withheld_tools_json, model_selection_json, runtime_mode,
            enabled, auto_create_for_feature, revision, created_at, updated_at
          )
          SELECT 'role:project-manager', 'Project manager', instructions, withheld_tools_json,
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

          // 103 ran before 116 renamed the roles' tools column.
          yield* sql`ALTER TABLE roles RENAME COLUMN withheld_tools_json TO allowed_tools_json`;
          yield* FeatureManagerMigration;
          yield* sql`ALTER TABLE roles RENAME COLUMN allowed_tools_json TO withheld_tools_json`;

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

  effectIt.effect("retitles open features' leads still called by their manager, once", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const engine = yield* OrchestrationEngineService;
        const sql = yield* SqlClient.SqlClient;
        const lead = Effect.fnUntraced(function* (id: string, oldTitle: string) {
          yield* features.create({ id, projectId, title: id, brief: "Brief", workspace: "local" });
          const { leadThreadId } = yield* features.start(id, projectId);
          expect((yield* engine.getThreadShell(leadThreadId))?.title).toBe(id);
          yield* engine.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`old-title:${id}`),
            threadId: leadThreadId,
            title: oldTitle,
          });
          return leadThreadId;
        });
        const older = yield* lead("older-feature", "Project manager");
        const newer = yield* lead("newer-feature", "Feature manager");
        const renamed = yield* lead("renamed-feature", "Launch thread");
        const closed = yield* lead("closed-feature", "Project manager");
        yield* sql`UPDATE features SET status = 'closed' WHERE id = 'closed-feature'`;

        yield* retitleFeatureManagerLeads();
        // Once: a person who names a lead "Feature manager" afterwards keeps that name.
        yield* engine.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("named-again:newer-feature"),
          threadId: newer,
          title: "Feature manager",
        });
        yield* retitleFeatureManagerLeads();

        expect((yield* engine.getThreadShell(older))?.title).toBe("older-feature");
        expect((yield* engine.getThreadShell(newer))?.title).toBe("Feature manager");
        expect((yield* engine.getThreadShell(renamed))?.title).toBe("Launch thread");
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
        // The lead starts named after the feature's stand-in, so it follows the new title.
        expect((yield* engine.getThreadShell(managerThreadId))?.title).toBe(standIn);

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
          parent: 40,
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

        // A thread linking the ticket itself follows it when it moves, and lets go when deleted.
        const engine = yield* OrchestrationEngineService;
        const { leadThreadId } = yield* features.start(target.id, projectId);
        const threadIssue = () =>
          engine.getThreadShell(leadThreadId).pipe(Effect.map((shell) => shell!.issue ?? null));
        yield* features.setThreadIssue(leadThreadId, "T-7");
        expect((yield* threadIssue())?.ticketId).toBe("ticket:a");
        yield* features.relinkTicketThreads(
          projectId,
          "ticket:a",
          "https://github.com/owner/repo/issues/42",
        );
        expect((yield* threadIssue())?.url).toBe("https://github.com/owner/repo/issues/42");
        yield* features.setThreadIssue(leadThreadId, "T-7");
        yield* features.relinkTicketThreads(projectId, "ticket:a", null);
        expect(yield* threadIssue()).toBeNull();
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
          const headquarters = yield* crew.ensureHeadquarters(CAPTAIN_ID);
          const shell = () => engine.getThreadShell(headquarters.threadId);

          yield* engine.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("test:archive-hq"),
            threadId: headquarters.threadId,
          });
          yield* crew.ensureHeadquarters(CAPTAIN_ID);
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
          const captain = (yield* bots.get(CAPTAIN_ID))!;
          const runtimeMode =
            captain.runtimeMode === "full-access" ? "approval-required" : "full-access";
          expect(
            yield* bots.update(
              { ...captain, runtimeMode, revision: captain.revision + 1 },
              captain.revision,
            ),
          ).toBe(true);
          yield* crew.ensureHeadquarters(CAPTAIN_ID);
          expect((yield* shell())?.runtimeMode).toBe(runtimeMode);
        }),
      ),
  );

  effectIt.effect(
    "keeps a project's manager unpinned in its project, following its settings until reset",
    () =>
      withSystem(
        Effect.gen(function* () {
          const crew = yield* CrewService;
          const engine = yield* OrchestrationEngineService;
          const crewStore = yield* CrewStore;
          const captain = (yield* (yield* BotStore.BotStore).get(CAPTAIN_ID))!;
          // No Library role: it starts on built-in instructions and its bot's model.
          expect(yield* crewStore.getRole("role:project-manager")).toBeNull();
          const before = yield* crew.projectManagerSettings(projectId);
          expect(before).toMatchObject({
            revision: 0,
            customized: false,
            threadId: null,
            modelSelection: captain.modelSelection,
            runtimeMode: "full-access",
          });
          expect(before.instructions).toContain("You manage one project");

          const run = yield* crew.ensureProjectManager(projectId);
          expect(run.threadId).toBe(projectHeadquartersThreadId(projectId));
          expect(yield* crew.ensureProjectManager(projectId)).toEqual(run);
          const shell = () => engine.getThreadShell(run.threadId);
          // It lives in its project, in the project's checkout.
          expect(yield* shell()).toMatchObject({ projectId, branch: null, worktreePath: null });
          // The sidebar header opens it, so it is not pinned, and opening it starts no turn.
          expect((yield* shell())?.pinnedAt).toBeNull();
          const opened = yield* engine.getThreadRecords(run.threadId, ["messages", "runs"]);
          expect([opened.messages, opened.runs]).toEqual([[], []]);
          // A pin the person adds stays.
          yield* engine.dispatch({
            type: "thread.pin",
            commandId: CommandId.make("test:pin-pm"),
            threadId: run.threadId,
          });
          yield* crew.ensureProjectManager(projectId);
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
          // Its look saves on its own: a manager still on its defaults stays on them.
          const icon = { avatar: captain.avatar, color: "teal" as const };
          const fresh = yield* crew.setProjectManagerIcon({ projectId, icon });
          expect(fresh).toMatchObject({ icon, customized: false, revision: 2 });
          expect(fresh.instructions).toBe(before.instructions);
          const runtimeMode =
            created.runtimeMode === "full-access" ? "approval-required" : "full-access";
          const saved = yield* crew.updateProjectManager({
            projectId,
            instructions: "Manage it my way.",
            withheldTools: ["worktree"],
            modelSelection: created.modelSelection,
            runtimeMode,
            longConversation: "new-session",
            expectedRevision: fresh.revision,
          });
          expect(saved).toMatchObject({
            icon,
            customized: true,
            revision: 3,
            longConversation: "new-session",
          });
          // The open thread follows: its mode now, its grants on the next tool call.
          expect((yield* shell())?.runtimeMode).toBe(runtimeMode);
          expect((yield* crewStore.getRun(run.id))?.withheldTools).toEqual(["worktree"]);
          expect(
            (yield* crew
              .updateProjectManager({ ...saved, instructions: "Stale", expectedRevision: 1 })
              .pipe(Effect.flip)).message,
          ).toContain("reload");
          expect(
            (yield* crew
              .updateProjectManager({ ...saved, allowedTools: [], expectedRevision: 3 })
              .pipe(Effect.flip)).message,
          ).toBe(LEGACY_TOOLS_MESSAGE);

          // A customized manager stays customized.
          const withIcon = yield* crew.setProjectManagerIcon({ projectId, icon });
          expect(withIcon).toMatchObject({ icon, revision: 4, customized: true });
          expect(withIcon.instructions).toBe("Manage it my way.");
          const reloaded = (yield* crewStore.getMember(`project-manager:${projectId}`))!;
          expect(reloaded.icon).toEqual(icon);

          // Reset puts it back on those defaults, keeping its look.
          const reset = yield* crew.resetProjectManager({ projectId, expectedRevision: 4 });
          expect(reset).toMatchObject({
            icon,
            customized: false,
            revision: 5,
            instructions: before.instructions,
            withheldTools: [],
            modelSelection: captain.modelSelection,
            runtimeMode: "full-access",
            longConversation: "compact",
          });
          expect((yield* shell())?.runtimeMode).toBe("full-access");
          const cleared = yield* crew.setProjectManagerIcon({ projectId, icon: null });
          expect(cleared).toMatchObject({ icon: null, customized: false, revision: 6 });

          // Off archives its thread and stops new work reaching it; on brings it back.
          const offSettings = yield* crew.setProjectManagerEnabled({ projectId, enabled: false });
          expect(offSettings.enabled).toBe(false);
          expect((yield* shell())?.archivedAt).not.toBeNull();
          for (const refused of [
            crew.ensureProjectManager(projectId),
            crew.requireProjectManagerOn(projectId),
          ]) {
            expect((yield* Effect.flip(refused)).message).toContain("turned off");
          }
          expect((yield* crew.setProjectManagerEnabled({ projectId, enabled: true })).enabled).toBe(
            true,
          );
          expect((yield* shell())?.archivedAt).toBeNull();
          expect(yield* crew.ensureProjectManager(projectId)).toMatchObject({
            threadId: run.threadId,
          });
        }),
      ),
  );

  // No bot and no saved default model, as on a fresh install: a project's manager and features
  // run on the model new threads there get, from the first usable provider.
  const looseProject = Effect.gen(function* () {
    const features = yield* FeatureService;
    const loose = ProjectId.make("workflow-feature-loose");
    const home = (yield* (yield* ProjectStore.ProjectStoreV2).get(projectId)).pipe(
      Option.getOrThrow,
    ).workspaceRoot;
    yield* seedCrewProject({
      projectId: loose,
      title: "Loose project",
      workspaceRoot: home,
      botId: null,
    });
    const target = { id: "loose-feature", projectId: loose };
    yield* features.create({ ...target, title: "Loose", brief: "Tidy up", workspace: "local" });
    return target;
  });

  effectIt.effect(
    "gives a project with no bot a manager and features on the model new threads get",
    () =>
      withSystem(
        Effect.gen(function* () {
          const crew = yield* CrewService;
          const features = yield* FeatureService;
          const settings = yield* ServerSettingsService;
          expect((yield* settings.getSettings).defaultModelSelection).toBeNull();
          const target = yield* looseProject;
          const inherited = { instanceId: readyCodex.instanceId, model: "gpt-5.4" };
          expect(yield* crew.projectManagerSettings(target.projectId)).toMatchObject({
            modelSelection: inherited,
            runtimeMode: "full-access",
          });
          const manager = yield* crew.ensureProjectManager(target.projectId);
          expect(manager.threadId).toBe(projectHeadquartersThreadId(target.projectId));
          const started = yield* features.start(target.id, target.projectId);
          expect(started.leadThreadId).toBeDefined();
        }),
        makeCrewTestOrchestration({ providers: [readyCodex] }),
      ),
  );

  effectIt.effect("refuses a project with no bot and no usable model", () =>
    withSystem(
      Effect.gen(function* () {
        const crew = yield* CrewService;
        const features = yield* FeatureService;
        const target = yield* looseProject;
        expect(
          (yield* Effect.flip(crew.projectManagerSettings(target.projectId))).message,
        ).toContain("Choose a default model for this project");
        expect((yield* Effect.flip(features.start(target.id, target.projectId))).message).toContain(
          "Set up the crew",
        );
      }),
    ),
  );

  effectIt.effect(
    "lets only a project's manager and its bot's headquarters save the manager's instructions",
    () =>
      withSystem(
        Effect.gen(function* () {
          const crew = yield* CrewService;
          const manager = projectHeadquartersThreadId(projectId);
          const captainHq = botHeadquartersThreadId(CAPTAIN_ID);
          const otherProject = ProjectId.make("workflow-feature-other");
          yield* seedCrewProject({
            projectId: otherProject,
            title: "Other project",
            workspaceRoot: "/tmp/workflow-feature-other",
          });
          const refusal = (callerThreadId: ThreadId, target: ProjectId | null = projectId) =>
            Effect.flip(
              crew.projectManagerInstructions({ callerThreadId, projectId: target ?? undefined }),
            ).pipe(Effect.map((error) => error.message));
          expect(yield* refusal(manager, otherProject)).toContain("only its own");
          expect(yield* refusal(projectHeadquartersThreadId(otherProject))).toContain(
            "only its own",
          );
          for (const caller of [
            ThreadId.make("plain-thread"),
            ThreadId.make("bot-run:feature-lead:feature-1"),
          ]) {
            expect(yield* refusal(caller)).toContain("Only a project's manager");
          }
          expect(yield* refusal(captainHq, null)).toContain("Name the projectId");
          expect(yield* refusal(botHeadquartersThreadId("other-bot"))).toContain(
            "isn't one of this bot's projects",
          );
          // A delegated child of the manager's thread never acts as the manager.
          expect(
            (yield* Effect.flip(
              crew.projectManagerInstructions({ callerThreadId: manager, callerIsSubagent: true }),
            )).message,
          ).toContain("subagent");

          // Two first saves at once: the member one makes, the other must not overwrite.
          const firstSaves = yield* Effect.forEach(
            ["First", "Second"],
            (instructions) =>
              Effect.result(
                crew.updateProjectManagerInstructions({
                  callerThreadId: projectHeadquartersThreadId(otherProject),
                  instructions,
                  expectedRevision: 0,
                }),
              ),
            { concurrency: 2 },
          );
          expect(firstSaves.filter((result) => result._tag === "Success")).toHaveLength(1);

          // A manager nobody customized follows the current built-in text, not what it stored.
          const crewStore = yield* CrewStore;
          const managerRun = yield* crew.ensureProjectManager(projectId);
          const stored = (yield* crewStore.getMember(`project-manager:${projectId}`))!;
          yield* crewStore.saveMember(
            { ...stored, instructions: "Old built-in text", revision: stored.revision + 1 },
            stored.revision,
          );
          yield* crewStore.setRunInstructions(managerRun.id, "Old built-in text");
          const read = yield* crew.projectManagerInstructions({ callerThreadId: manager });
          expect(read).toMatchObject({ projectId, customized: false });
          expect(read.instructions).toContain("You manage one project");
          // Its thread's first message, before anything reopens it, briefs it with that text too.
          const briefing = () =>
            TurnBriefing.TurnBriefing.pipe(
              Effect.flatMap((turnBriefing) => turnBriefing.forThread(manager)),
              Effect.provide(StandingBriefingLive),
            );
          expect(yield* briefing()).toContain(read.instructions);
          expect((yield* crew.ensureProjectManager(projectId)).instructions).toBe(
            read.instructions,
          );
          const captain = (yield* (yield* BotStore.BotStore).get(CAPTAIN_ID))!;
          const icon = { avatar: captain.avatar, color: "teal" as const };
          const before = yield* crew.setProjectManagerIcon({ projectId, icon });
          const rule = `${read.instructions}\n\nEvery piece of work starts from a GitHub issue.`;
          const saved = yield* crew.updateProjectManagerInstructions({
            callerThreadId: manager,
            instructions: rule,
            expectedRevision: before.revision,
          });
          expect(saved).toEqual({
            projectId,
            instructions: rule,
            revision: before.revision + 1,
            customized: true,
          });
          expect((yield* crew.ensureProjectManager(projectId)).instructions).toBe(rule);
          expect(yield* briefing()).toContain(rule);
          const after = yield* crew.projectManagerSettings(projectId);
          expect(after).toMatchObject({
            icon,
            enabled: true,
            modelSelection: before.modelSelection,
            runtimeMode: before.runtimeMode,
            withheldTools: before.withheldTools,
            longConversation: before.longConversation,
          });

          const stale = yield* Effect.flip(
            crew.updateProjectManagerInstructions({
              callerThreadId: captainHq,
              projectId,
              instructions: "Overwrite",
              expectedRevision: before.revision,
            }),
          );
          expect(stale.message).toContain("Read them again");
          expect((yield* crew.projectManagerSettings(projectId)).instructions).toBe(rule);
          const fromHq = yield* crew.updateProjectManagerInstructions({
            callerThreadId: captainHq,
            projectId,
            instructions: `${rule}\nShip on Fridays.`,
            expectedRevision: saved.revision,
          });
          expect(fromHq.revision).toBe(saved.revision + 1);

          const reset = yield* crew.resetProjectManager({
            projectId,
            expectedRevision: fromHq.revision,
          });
          expect(reset).toMatchObject({ customized: false, instructions: read.instructions, icon });
        }),
      ),
  );
});
