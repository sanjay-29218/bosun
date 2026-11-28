import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  type Bot,
  type BotMoveProjectInput,
  botHeadquartersThreadId,
  NodeId,
  type OrchestrationV2Subagent,
  FEATURE_DELIVERY_WORKFLOW_ID,
  type Project,
  ProjectId,
  type ProjectRemoteBot,
  type ProjectRemoteManager,
  projectHeadquartersThreadId,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  WorkflowSnapshot,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import type { CreateCrewRunInput } from "../crew/CrewService.ts";
import { LibraryImports } from "../crew/LibraryImports.ts";
import { CrewApprovals } from "../crew/CrewApprovals.ts";
import { CrewService } from "../crew/CrewService.ts";
import { CrewStore } from "../crew/CrewStore.ts";
import { FEATURE_LEAD_INSTRUCTIONS } from "../crew/crewPrompts.ts";
import { ProjectRequests } from "../crew/ProjectRequests.ts";
import { FeatureService } from "../features/FeatureService.ts";
import { type Notice, NoticeInbox } from "../features/NoticeInbox.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../peer/PeerLinks.testkit.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TicketService } from "../tickets/TicketService.ts";
import * as BotReach from "./BotReach.ts";
import * as BotService from "./BotService.ts";
import * as BotTransfer from "./BotTransfer.ts";

const CAPTAIN_ID = "bot-ops";

// Captain on the laptop reaches the projects the box gave it: both are real /mcp toolkits and
// real BotReach, the box behind real OAuth, with their data mocked.

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const couch = descriptorOf("environment-couch", "Couch");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
/** What a request runs with there: the model and access it was sent with. */
const carried = { modelSelection, runtimeMode: "full-access" as const };

const bot = (id: string, name: string, position: number): Bot => ({
  id,
  name,
  avatar: { head: "round", face: "visor", eyes: "round", top: "none", cheeks: false, smile: true },
  color: "blue",
  instructions: "",
  modelSelection,
  linkedEnvironmentIds: [],
  position,
  revision: 1,
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
});
const project = (
  id: string,
  title: string,
  botId: string | null,
  remoteBot: ProjectRemoteBot | null = null,
  manager: {
    readonly remoteManager?: ProjectRemoteManager;
  } = {},
) =>
  ({
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/home/user/${title}`,
    botId,
    remoteBot,
    deletedAt: null,
    ...manager,
  }) as unknown as Project;

/** The laptop's web project's manager, which also works on the box's copy. */
const webManagerOnLaptop: ProjectRemoteManager = {
  environmentId: laptop.environmentId,
  projectId: ProjectId.make("project:laptop"),
  homeLabel: "Laptop",
};
/** A feature on the box that stopped to ask the person, for a request the laptop's manager sent. */
const boxQuestion = {
  threadId: ThreadId.make("bot-run:link-task:web"),
  key: "feature-report:request:approval-1",
  text: 'Feature "Dark mode" needs you: Planner is asking in thread thread:planner. The person answers it there.',
  failed: false,
  createdAt: "2999-01-01T00:00:00.000Z",
};

/** Captain on the laptop, as the box last heard of it. */
const captainFromLaptop: ProjectRemoteBot = {
  environmentId: laptop.environmentId,
  botId: CAPTAIN_ID,
  name: "Captain",
  homeLabel: "Old laptop",
};

interface Environment {
  readonly posted?: Array<Notice>;
  readonly bots: ReadonlyArray<Bot>;
  readonly projects: ReadonlyArray<Project>;
  readonly workflowRevision?: number;
  /** Its providers; a signed-in Codex by default. */
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly fallbackModelSelection?: ModelSelection;
  /** Runs as a run is created there, before it is recorded. */
  readonly beforeCreate?: Effect.Effect<void>;
}

/** What one environment's services were asked to change. */
interface Seen {
  readonly moves: ReadonlyArray<BotMoveProjectInput>;
  readonly runs: ReadonlyArray<CreateCrewRunInput>;
}

const nothingSeen: Seen = { moves: [], runs: [] };

const waitingForCouch = {
  id: NodeId.make("task:couch"),
  result: null,
  pendingRemote: {
    environmentId: couch.environmentId,
    label: "Couch",
    projectId: ProjectId.make("project:couch"),
    botId: CAPTAIN_ID,
    title: "Fix the couch",
    modelSelection,
    runtimeMode: "full-access",
    clientRequestId: "delegate:couch",
  },
} as unknown as OrchestrationV2Subagent;

const signedInCodex = {
  instanceId: modelSelection.instanceId,
  driver: "codex",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  models: [{ slug: modelSelection.model }],
} as unknown as ServerProvider;
const signedOutCodex = { ...signedInCodex, auth: { status: "unauthenticated" as const } };
const claudeModel = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};
const signedInClaude = {
  ...signedInCodex,
  instanceId: claudeModel.instanceId,
  driver: "claudeAgent",
} as unknown as ServerProvider;

/** One environment's bots, projects, features, crew and providers, around real BotReach. */
const layerData = (data: Environment, seen: Ref.Ref<Seen>) =>
  Layer.mergeAll(
    Layer.mock(BotService.BotService)({
      list: Effect.succeed(data.bots),
      get: (id) => Effect.succeed(data.bots.find((candidate) => candidate.id === id) ?? null),
      moveProject: (input) =>
        Ref.update(seen, (current) => ({ ...current, moves: [...current.moves, input] })).pipe(
          Effect.as({
            ...data.projects.find((candidate) => candidate.id === input.projectId)!,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-11-05T00:00:00.000Z",
            updatedAt: "2026-11-05T00:00:00.000Z",
            botId: input.botId,
          }),
        ),
    }),
    Layer.mock(ProjectService.ProjectService)({
      snapshot: Effect.succeed({ projects: data.projects, updatedAt: "2026-11-05" } as never),
      getById: (id) =>
        Effect.succeed(
          Option.fromNullishOr(data.projects.find((candidate) => candidate.id === id)),
        ),
      assignBot: ({ projectId, botId, remoteBot }) =>
        Ref.update(seen, (current) => ({
          ...current,
          moves: [
            ...current.moves,
            { projectId, botId, ...(remoteBot === undefined ? {} : { remoteBot }) },
          ],
        })).pipe(Effect.as({} as never)),
    }),
    Layer.mock(FeatureService)({
      listByProject: (projectId) =>
        Effect.succeed(
          projectId === "project:omni"
            ? ([
                { id: "feature:dark-mode", title: "Dark mode", status: "open" },
                { id: "feature:old", title: "Old work", status: "closed" },
              ] as never)
            : [],
        ),
    }),
    Layer.mock(CrewApprovals)({}),
    Layer.mock(NoticeInbox)({
      post: (notice) => Effect.sync(() => void data.posted?.push(notice)),
      // The box's request threads in its web project heard one question.
      postedToLinkedRequests: ({ projectIds, since }) =>
        Effect.succeed(
          projectIds.includes(ProjectId.make("project:web")) && boxQuestion.createdAt > since
            ? [boxQuestion]
            : [],
        ),
    }),
    Layer.mock(CrewService)({
      // Each environment's Feature delivery: the laptop's is at revision 3 with an extra role.
      getWorkflow: () =>
        Effect.succeed({
          id: FEATURE_DELIVERY_WORKFLOW_ID,
          name: "Feature delivery",
          instructions: `Revision ${data.workflowRevision ?? 1}.`,
          crewRoleIds: ["role:builder", "role:security-reviewer"],
          revision: data.workflowRevision ?? 1,
        } as never),
      getRole: (id) =>
        Effect.succeed({
          id,
          name: id,
          instructions: `You are ${id}.`,
          ...(id === "role:security-reviewer"
            ? // On a provider the box lacks; a feature checks it, a request doesn't.
              { modelSelection: { instanceId: "opencode", model: "big-pickle" } }
            : { modelSelection }),
          enabled: true,
        } as never),
      ensureLinkedRequestMember: (projectId) =>
        Effect.succeed({ id: `bot-manager:${projectId}` } as never),
      // A run whose task says so is still queued, as one whose dispatch failed.
      cancelQueuedRun: (id) =>
        Ref.get(seen).pipe(
          Effect.map((current) => {
            const run = current.runs.find((candidate) => candidate.id === id);
            return run === undefined
              ? null
              : ({
                  run: { threadId: `bot-run:${id}`, modelSelection: run.carried?.modelSelection },
                  started: !run.taskText.startsWith("Queued:"),
                } as never);
          }),
        ),
      // Idempotent on its id, as the real one is; refuses a task as CrewService does.
      createRun: (input) =>
        input.taskText.length > 16_000
          ? Effect.fail(
              Object.assign(new Error("Invalid task"), { _tag: "CrewValidationError" }) as never,
            )
          : input.taskText === "Fails to start."
            ? Effect.fail(new Error("The lead's thread could not start.") as never)
            : (data.beforeCreate ?? Effect.void).pipe(
                Effect.andThen(
                  Ref.update(seen, (current) =>
                    current.runs.some((run) => run.id === input.id)
                      ? current
                      : { ...current, runs: [...current.runs, input] },
                  ),
                ),
                Effect.as({
                  threadId: `bot-run:${input.id}`,
                  modelSelection: input.carried?.modelSelection,
                } as never),
              ),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(data.providers ?? [signedInCodex]),
    }),
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        fallbackModelSelection: data.fallbackModelSelection ?? null,
      }),
    }),
    Layer.mock(GitWorkflowService)({ currentBranch: () => Effect.succeed("main") }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isHiddenProject: (id) => Effect.succeed(id.endsWith(":hidden")),
    }),
  );

/** The crew toolkits and what they read besides BotReach's data. */
const layerToolServices = Layer.mergeAll(
  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
  Layer.mock(BotTransfer.BotTransfer)({}),
  Layer.mock(CrewStore)({}),
  Layer.mock(LibraryImports)({}),
  Layer.mock(ProjectRequests)({}),
  Layer.mock(IssueService.IssueService)({}),
  Layer.mock(TicketService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(liveThreadShell(threadId, { runtimeMode: "full-access" })),
    // Captain's headquarters has one request waiting for the asleep couch.
    getThreadRecords: (threadId) =>
      Effect.succeed({
        subagents:
          threadId === botHeadquartersThreadId(CAPTAIN_ID)
            ? [
                waitingForCouch,
                { ...waitingForCouch, id: NodeId.make("task:done"), result: "Done." },
              ]
            : [],
      } as never),
  }),
);

const boxData: Environment = {
  // A copy of Captain made on the box before bots could own projects elsewhere.
  bots: [bot("bot:captain-copy", "Captain", 0), bot("bot:social-box", "Social", 1)],
  projects: [
    project("project:omni", "omni-mono", null, captainFromLaptop),
    project("project:blog", "blog", "bot:social-box"),
    project("project:notes", "notes", null),
    project("project:api", "api", "bot:captain-copy"),
    project("project:web", "web", null, null, { remoteManager: webManagerOnLaptop }),
  ],
};

/** The box: its real /mcp with the crew toolkits and real BotReach. */
const serveBox = (seen: Ref.Ref<Seen>, beforeCreate?: Effect.Effect<void>) =>
  servePeer(
    box,
    McpHttpServer.layerCrewTools.pipe(
      Layer.provide(BotReach.layer),
      Layer.provide(
        layerData(beforeCreate === undefined ? boxData : { ...boxData, beforeCreate }, seen),
      ),
      Layer.provide(layerToolServices),
      Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
      Layer.provide(Layer.mock(PeerLinks.PeerLinks)({ list: Effect.succeed([]) })),
    ),
  );

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "bot-reach-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bot-reach-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const headquarters = botHeadquartersThreadId(CAPTAIN_ID);
const headquartersScope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: laptop.environmentId,
  requestNamespace: "provider-session:captain",
  thread: {
    threadId: headquarters,
    providerSessionId: "provider-session:captain",
    providerInstanceId: modelSelection.instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration", "crew"]),
  issuedAt: 1,
  linkedEnvironments: true,
};

/** The laptop: Captain's headquarters calls its own crew toolkits, which reach its links. */
const makeLaptop = (captain = bot(CAPTAIN_ID, "Captain", 0), botsHere = [captain]) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<Seen>(nothingSeen);
    const posted: Array<Notice> = [];
    const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
    const here = yield* McpHttpServer.layerCrewTools.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provideMerge(BotReach.layer),
      Layer.provide(
        layerData(
          {
            bots: botsHere,
            posted,
            projects: [
              project("project:laptop", "laptop-app", CAPTAIN_ID),
              project("project:scratch:hidden", "No project", CAPTAIN_ID),
              project("project:captain-home:hidden", "Captain", CAPTAIN_ID),
            ],
            workflowRevision: 3,
          },
          seen,
        ),
      ),
      Layer.provide(PeerForwarding.layer),
      Layer.provide(layerToolServices),
      Layer.provide(Layer.succeedContext(linking)),
      Layer.provide(NodeCrypto.layer),
      Layer.fresh,
      Layer.build,
    );
    const server = Context.get(here, McpServer.McpServer);
    const callAs =
      (scope: McpInvocationContext.McpInvocationScope) =>
      (name: string, args: Record<string, unknown>) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, mcpClient),
          );
    return {
      links: Context.get(linking, PeerLinks.PeerLinks),
      reach: Context.get(here, BotReach.BotReach),
      posted,
      call: callAs(headquartersScope),
      callAs,
    };
  });

/** Links the laptop to a couch, on its own server, that then goes to sleep. */
const linkSleepingCouch = (links: PeerLinks.PeerLinks["Service"]) =>
  servePeer(couch, Layer.empty).pipe(
    Effect.flatMap((served) => linkTo(links, served, "full-access")),
    // Fresh: the box's test server is memoized, and the couch needs one of its own.
    Effect.provide(Layer.fresh(NodeHttpServer.layerTest)),
    Effect.scoped,
  );

/** A workflow as a machine from before workflows lost their lead role reads it. */
const decodeOlderWorkflowSnapshot = Schema.decodeUnknownSync(
  Schema.Struct({
    workflow: Schema.Struct({
      ...WorkflowSnapshot.fields.workflow.fields,
      leadRoleId: Schema.String,
    }),
    roles: WorkflowSnapshot.fields.roles,
  }),
);

const launch = (projectId: string, model = modelSelection.model) => ({
  projectId: ProjectId.make(projectId),
  task: "Start a feature: dark mode.",
  title: "Dark mode",
  modelSelection: { ...modelSelection, model },
  runtimeMode: "full-access" as const,
  clientRequestId: `delegate:${projectId}:${model}`,
});

it.live("Captain here lists, sees and takes its projects on a linked environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const boxSeen = yield* Ref.make<Seen>(nothingSeen);
      const b = yield* serveBox(boxSeen);
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "full-access");
      yield* linkSleepingCouch(a.links);

      const listed = yield* a.call("t3_bot_projects", {});
      expect(listed.isError, JSON.stringify(listed.content)).toBe(false);
      expect(listed.structuredContent).toMatchObject({
        bot: { id: CAPTAIN_ID, name: "Captain" },
        projects: [
          { environmentId: laptop.environmentId, projectId: "project:laptop", openFeatures: [] },
          {
            environmentId: box.environmentId,
            environmentLabel: "Box",
            projectId: "project:omni",
            title: "omni-mono",
            botId: CAPTAIN_ID,
            openFeatures: [{ featureId: "feature:dark-mode", title: "Dark mode" }],
          },
        ],
      });
      const environments = (
        listed.structuredContent as {
          readonly environments: ReadonlyArray<{
            readonly environmentId: string;
            readonly reachable: boolean;
            readonly lastReachedAt: string | null;
          }>;
        }
      ).environments;
      expect(environments.find((entry) => entry.environmentId === box.environmentId)).toMatchObject(
        { reachable: true },
      );
      // The asleep couch is listed as unreachable, with when it last answered.
      const asleep = environments.find((entry) => entry.environmentId === couch.environmentId);
      // ...with the request waiting for it, and not the one that already ended.
      expect(asleep).toMatchObject({
        reachable: false,
        waiting: [{ taskId: "task:couch", projectId: "project:couch", title: "Fix the couch" }],
      });
      expect(asleep?.lastReachedAt).toEqual(expect.any(String));

      const bots = yield* a.call("t3_bot_list", { environmentId: box.environmentId });
      expect(bots.isError, JSON.stringify(bots.content)).toBe(false);
      expect(bots.structuredContent).toMatchObject({
        bots: [
          { id: "bot:captain-copy", home: { environmentId: box.environmentId, label: "Box" } },
          { id: "bot:social-box", name: "Social" },
        ],
      });
      // Here, Captain may work on every linked machine: the box, which answers, and the couch,
      // which is asleep.
      const own = yield* a.call("t3_bot_list", {});
      expect(own.isError, JSON.stringify(own.content)).toBe(false);
      expect(own.structuredContent).toMatchObject({
        bots: [
          {
            id: CAPTAIN_ID,
            home: { environmentId: laptop.environmentId, label: "Laptop" },
            permittedEnvironments: [
              { environmentId: box.environmentId, label: "Box", reachable: true },
              { environmentId: couch.environmentId, label: "Couch", reachable: false },
            ],
          },
        ],
      });
      // An agent moves projects there between that environment's own bots only.
      const moved = yield* a.call("t3_bot_move_project", {
        environmentId: box.environmentId,
        projectId: "project:blog",
        botId: "bot:social-box",
      });
      expect(moved.isError, JSON.stringify(moved.content)).toBe(false);
      expect((yield* Ref.get(boxSeen)).moves).toEqual([
        { projectId: "project:blog", botId: "bot:social-box" },
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.live(
  "a cancel that arrives while its request starts there waits for it, then names its run",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const boxSeen = yield* Ref.make<Seen>(nothingSeen);
        const creating = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const linking = yield* layerLinkingEnvironment(box).pipe(Layer.build);
        // The box's own BotReach, called as its link session would be.
        const here = yield* BotReach.layer.pipe(
          Layer.provide(
            layerData(
              {
                ...boxData,
                beforeCreate: Deferred.succeed(creating, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                ),
              },
              boxSeen,
            ),
          ),
          Layer.provide(layerToolServices),
          Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
          Layer.provide(Layer.succeedContext(linking)),
          Layer.build,
        );
        const reach = Context.get(here, BotReach.BotReach);
        const linkScope = (
          access: "full-access" | "auto",
        ): McpInvocationContext.McpInvocationScope => ({
          environmentId: box.environmentId,
          requestNamespace: "link-session",
          thread: undefined,
          client: { sessionId: `link-${access}`, label: "T3 Code · Laptop", access, linked: true },
          capabilities: new Set(["orchestration", "crew"]),
          issuedAt: 1,
        });
        const request = {
          ...launch("project:omni"),
          home: {
            environmentId: laptop.environmentId,
            botId: CAPTAIN_ID,
            botName: "Captain",
            label: "Laptop",
          },
        };

        const launching = yield* reach
          .startForLink(linkScope("full-access"), request)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(creating);
        // Over a link below full access, as stopping work is allowed; it waits for the launch.
        const cancelling = yield* reach
          .startForLink(linkScope("auto"), { ...request, cancelIfStarted: true })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        const launched = yield* Fiber.join(launching);
        // Not "nothing runs", which would leave the run the launch just made running there.
        const cancelled = yield* Fiber.join(cancelling);
        expect(cancelled.threadId).toBe(launched.threadId);
        // Sent without a workflow, it runs as the bot, which must be able to run here.
        expect((yield* Ref.get(boxSeen)).runs[0]?.carried).toEqual({
          runtimeMode: "full-access",
          modelSelection,
        });
        // Codex is signed out there: the task runs on the box's fallback model instead.
        const reachWith = (data: Partial<Environment>) =>
          BotReach.layer.pipe(
            Layer.provide(layerData({ ...boxData, ...data }, boxSeen)),
            Layer.provide(layerToolServices),
            Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
            Layer.provide(Layer.succeedContext(linking)),
            Layer.build,
            Effect.map((context) => Context.get(context, BotReach.BotReach)),
          );
        const signedOut = { ...request, clientRequestId: "codex-signed-out" };
        const fellBack = yield* (yield* reachWith({
          providers: [signedOutCodex, signedInClaude],
          fallbackModelSelection: claudeModel,
        })).startForLink(linkScope("full-access"), signedOut);
        expect(fellBack.threadId).toMatch(/^bot-run:link-task:/);
        // With no fallback that can run there either, it still starts; its thread there says why.
        const blocked = yield* (yield* reachWith({
          providers: [signedOutCodex, { ...signedInClaude, auth: { status: "unauthenticated" } }],
          fallbackModelSelection: claudeModel,
        })).startForLink(linkScope("full-access"), { ...signedOut, clientRequestId: "stuck" });
        expect(blocked.threadId).toMatch(/^bot-run:link-task:/);
        // A machine with no roles of its own runs the request on the workflow sent: no lead role
        // is needed there or in the snapshot.
        const sentModel = { ...modelSelection, model: "gpt-5.4-mini" };
        const workflow = {
          workflow: {
            id: FEATURE_DELIVERY_WORKFLOW_ID,
            name: "Feature delivery",
            instructions: "Plan it, then build it.",
            crewRoleIds: [],
            revision: 1,
          },
          roles: [],
        };
        yield* (yield* reachWith({})).startForLink(linkScope("full-access"), {
          ...request,
          clientRequestId: "no-roles-here",
          modelSelection: sentModel,
          workflow,
        });
        expect((yield* Ref.get(boxSeen)).runs.at(-1)).toMatchObject({
          memberId: "bot-manager:project:omni",
          carried: { modelSelection: sentModel, runtimeMode: "full-access" },
          workflow: { snapshot: workflow },
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const managerThread = projectHeadquartersThreadId("project:laptop");
const managerScope: McpInvocationContext.McpThreadInvocationScope = {
  ...headquartersScope,
  requestNamespace: "provider-session:web-manager",
  thread: { ...headquartersScope.thread, threadId: managerThread },
};

it.live(
  "a project's manager works on its project's copy on any linked machine, nothing ticked",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const boxSeen = yield* Ref.make<Seen>(nothingSeen);
        const b = yield* serveBox(boxSeen);
        const a = yield* makeLaptop();
        yield* linkTo(a.links, b, "full-access");
        const manager = { managerProjectId: ProjectId.make("project:laptop") };

        // Its project here and the copy on the box whose manager it is.
        const listed = JSON.stringify(yield* a.callAs(managerScope)("t3_bot_projects", {}));
        expect(listed).toContain("laptop-app's manager");
        expect(listed).toContain('\\"projectId\\":\\"project:web\\"');
        expect(listed).not.toContain("project:omni");

        // A request for the box's copy starts there as a linked request.
        const launched = yield* a.reach.launchProjectManager(
          managerScope,
          box.environmentId,
          manager,
          launch("project:web"),
        );
        expect(launched.threadId).toMatch(/^bot-run:link-task:/);
        expect((yield* Ref.get(boxSeen)).runs).toMatchObject([
          { memberId: "bot-manager:project:web", projectId: "project:web" },
        ]);
        // Its manager isn't Captain, so the box's owner stays as it was.
        expect((yield* Ref.get(boxSeen)).moves).toEqual([]);

        // A copy with its own manager there, and a machine that isn't linked, start nothing.
        const refused = (environmentId: typeof box.environmentId, projectId: string) =>
          a.reach
            .launchProjectManager(managerScope, environmentId, manager, launch(projectId))
            .pipe(
              Effect.flip,
              Effect.map((error) => error.message),
            );
        expect(yield* refused(box.environmentId, "project:notes")).toBe(
          "notes on Box has its own project manager, not laptop-app's manager from Laptop. Set it to live on Laptop in Project settings → Project manager first.",
        );
        expect(yield* refused(couch.environmentId, "project:couch")).toContain(
          "environment-couch isn't linked to this machine, so nothing was started there.",
        );
        expect((yield* Ref.get(boxSeen)).runs).toHaveLength(1);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.live(
  "a project's manager hears, once, when work it started on the box waits on the person",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveBox(yield* Ref.make<Seen>(nothingSeen));
        const a = yield* makeLaptop();
        yield* linkTo(a.links, b, "full-access");

        yield* a.reach.relayManagerNotices;
        yield* a.reach.relayManagerNotices;
        expect(a.posted).toEqual([
          {
            threadId: managerThread,
            key: `linked-notice:${box.environmentId}:${boxQuestion.threadId}:${boxQuestion.key}`,
            text: `On Box, for the request in thread ${boxQuestion.threadId} there:\n\n${boxQuestion.text}`,
          },
        ]);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.live("starts the project manager there, or says before starting anything why not", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const boxSeen = yield* Ref.make<Seen>(nothingSeen);
      const b = yield* serveBox(boxSeen);
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "full-access");
      const start = (input: ReturnType<typeof launch>) =>
        a.reach
          .launchProjectManager(headquartersScope, box.environmentId, { botId: CAPTAIN_ID }, input)
          .pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );

      const launched = yield* a.reach.launchProjectManager(
        headquartersScope,
        box.environmentId,
        { botId: CAPTAIN_ID },
        launch("project:omni"),
      );
      // Starts though its Security reviewer's provider isn't on the box: each role picks its
      // model when its own run starts.
      expect(launched.threadId).toMatch(/^bot-run:link-task:/);
      expect((yield* Ref.get(boxSeen)).runs).toMatchObject([
        {
          memberId: "bot-manager:project:omni",
          projectId: "project:omni",
          taskText: "Start a feature: dark mode.",
          carried,
          workspace: { branch: expect.stringMatching(/^bosun\/dark-mode-/), baseRef: "main" },
          // The laptop's workflow goes along by value, for the features this request starts.
          workflow: {
            here: "Box",
            from: "T3 Code · Laptop",
            snapshot: {
              workflow: {
                id: FEATURE_DELIVERY_WORKFLOW_ID,
                revision: 3,
                instructions: "Revision 3.",
              },
              roles: [
                { id: "role:feature-manager" },
                { id: "role:builder" },
                { id: "role:security-reviewer", instructions: "You are role:security-reviewer." },
              ],
            },
          },
        },
      ]);
      // A box from before workflows lost their lead role requires one, and leads with its role.
      const older = decodeOlderWorkflowSnapshot(
        (yield* Ref.get(boxSeen)).runs[0]?.workflow?.snapshot,
      );
      expect(older.roles.find((role) => role.id === older.workflow.leadRoleId)).toEqual({
        id: "role:feature-manager",
        name: "Feature manager",
        instructions: FEATURE_LEAD_INSTRUCTIONS,
        modelSelection,
        runtimeMode: "full-access",
      });
      expect(older.workflow.crewRoleIds).not.toContain("role:feature-manager");

      // The box shows Captain under the name and home it now has.
      expect((yield* Ref.get(boxSeen)).moves).toEqual([
        {
          projectId: "project:omni",
          botId: null,
          remoteBot: { ...captainFromLaptop, homeLabel: "Laptop" },
        },
      ]);

      // The same request again, even over a new link session as after a re-link, or once the
      // box is back after it started the run but its answer was lost, finds that run.
      yield* linkTo(a.links, b, "full-access");
      const retried = yield* a.reach.launchProjectManager(
        headquartersScope,
        box.environmentId,
        { botId: CAPTAIN_ID },
        launch("project:omni"),
      );
      expect(retried.threadId).toBe(launched.threadId);
      expect((yield* Ref.get(boxSeen)).runs).toHaveLength(1);
      // Asked only for what started, it finds that run, and starts nothing for another key.
      const found = yield* a.reach.launchProjectManager(
        headquartersScope,
        box.environmentId,
        { botId: CAPTAIN_ID },
        {
          ...launch("project:omni"),
          cancelIfStarted: true,
        },
      );
      expect(found.threadId).toBe(launched.threadId);
      const none = yield* a.reach
        .launchProjectManager(
          headquartersScope,
          box.environmentId,
          { botId: CAPTAIN_ID },
          {
            ...launch("project:omni"),
            clientRequestId: "never-sent",
            cancelIfStarted: true,
          },
        )
        .pipe(Effect.flip);
      expect(none.code).toBe("run_not_found");
      expect((yield* Ref.get(boxSeen)).runs).toHaveLength(1);
      // A run still queued there is cancelled there, and reads as nothing running.
      yield* a.reach.launchProjectManager(
        headquartersScope,
        box.environmentId,
        { botId: CAPTAIN_ID },
        {
          ...launch("project:omni"),
          task: "Queued: its dispatch failed there.",
          clientRequestId: "queued-there",
        },
      );
      const queued = yield* a.reach
        .launchProjectManager(
          headquartersScope,
          box.environmentId,
          { botId: CAPTAIN_ID },
          {
            ...launch("project:omni"),
            clientRequestId: "queued-there",
            cancelIfStarted: true,
          },
        )
        .pipe(Effect.flip);
      expect(queued.code).toBe("run_not_found");
      // With Captain since deleted here, cleanup still reaches the box by the request's record.
      const deleted = yield* makeLaptop(undefined, []);
      yield* linkTo(deleted.links, b, "full-access");
      const stillFound = yield* deleted.reach.launchProjectManager(
        headquartersScope,
        box.environmentId,
        { botId: CAPTAIN_ID },
        { ...launch("project:omni"), cancelIfStarted: true },
      );
      expect(stillFound.threadId).toBe(launched.threadId);
      const noNewWork = yield* deleted.reach
        .launchProjectManager(
          headquartersScope,
          box.environmentId,
          { botId: CAPTAIN_ID },
          launch("project:omni"),
        )
        .pipe(Effect.flip);
      expect(noNewWork.message).toContain("bot is gone");
      // A task the box refuses as it is stays refused, so it can't wait forever.
      const invalid = yield* a.reach
        .launchProjectManager(
          headquartersScope,
          box.environmentId,
          { botId: CAPTAIN_ID },
          {
            ...launch("project:omni"),
            task: "x".repeat(16_001),
            clientRequestId: "too-long",
          },
        )
        .pipe(Effect.flip);
      expect(invalid).toMatchObject({ code: "invalid_request", message: "Invalid task" });
      // A failure the box marks as passing (not a refusal) keeps the request waiting.
      const failedThere = yield* a.reach
        .launchProjectManager(
          headquartersScope,
          box.environmentId,
          { botId: CAPTAIN_ID },
          { ...launch("project:omni"), task: "Fails to start.", clientRequestId: "fails" },
        )
        .pipe(Effect.flip);
      expect(failedThere).toMatchObject({
        code: "orchestration_error",
        message: "The lead's thread could not start.",
      });

      expect(yield* start(launch("project:blog"))).toContain(
        "blog on Box belongs to Social on Box, not Captain from Laptop",
      );
      expect(yield* start(launch("project:notes"))).toContain("notes on Box has no bot");
      // A copy of Captain made there keeps its project until the person moves it.
      expect(yield* start(launch("project:api"))).toContain(
        "api on Box belongs to Captain on Box, not Captain from Laptop",
      );
      // The omni run, and the one left queued above; refusals start nothing.
      expect((yield* Ref.get(boxSeen)).runs).toHaveLength(2);
      // It runs on the model the sender passed.
      yield* a.reach.launchProjectManager(
        headquartersScope,
        box.environmentId,
        { botId: CAPTAIN_ID },
        launch("project:omni", "gpt-elsewhere"),
      );
      expect((yield* Ref.get(boxSeen)).runs.at(-1)?.carried).toEqual({
        ...carried,
        modelSelection: { ...modelSelection, model: "gpt-elsewhere" },
      });
      // It runs with the access it was sent with.
      yield* a.reach.launchProjectManager(
        headquartersScope,
        box.environmentId,
        { botId: CAPTAIN_ID },
        {
          ...launch("project:omni"),
          runtimeMode: "approval-required",
          clientRequestId: "sent-approval-required",
        },
      );
      expect((yield* Ref.get(boxSeen)).runs.at(-1)?.carried).toEqual({
        ...carried,
        runtimeMode: "approval-required",
      });

      // The box answers its descriptor, then a gateway in front of its /mcp answers 503: the
      // request waits as for a box that is away, not refused.
      yield* Ref.set(b.mcpStatus, 503);
      const gatewayDown = yield* a.reach
        .launchProjectManager(
          headquartersScope,
          box.environmentId,
          { botId: CAPTAIN_ID },
          { ...launch("project:omni"), clientRequestId: "gateway-down" },
        )
        .pipe(Effect.flip);
      expect(gatewayDown.code).toBe("orchestration_error");
      expect(gatewayDown.message).toMatch(/Project project:omni is on Box, which isn't reachable/);
      yield* Ref.set(b.mcpStatus, null);

      yield* linkSleepingCouch(a.links);
      const asleep = yield* a.reach
        .launchProjectManager(
          headquartersScope,
          couch.environmentId,
          { botId: CAPTAIN_ID },
          launch("project:couch"),
        )
        .pipe(Effect.flip);
      expect(asleep.message).toMatch(
        /Project project:couch is on Couch, which isn't reachable \(last reached/,
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses a bot's project work over a link below full access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const boxSeen = yield* Ref.make<Seen>(nothingSeen);
      const b = yield* serveBox(boxSeen);
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "auto");

      const refused = yield* a.reach
        .launchProjectManager(
          headquartersScope,
          box.environmentId,
          { botId: CAPTAIN_ID },
          launch("project:omni"),
        )
        .pipe(Effect.flip);
      expect(refused.message).toContain("Link Box again with full access");
      expect((yield* Ref.get(boxSeen)).runs).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("starts a bot's work on any linked environment, and none on an unlinked one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const boxSeen = yield* Ref.make<Seen>(nothingSeen);
      const b = yield* serveBox(boxSeen);
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "full-access");

      // Nothing is ticked anywhere: the link is all it takes.
      yield* a.reach.launchProjectManager(
        headquartersScope,
        box.environmentId,
        { botId: CAPTAIN_ID },
        launch("project:omni"),
      );
      expect((yield* Ref.get(boxSeen)).runs).toHaveLength(1);
      const refused = yield* a.reach
        .launchProjectManager(
          headquartersScope,
          couch.environmentId,
          { botId: CAPTAIN_ID },
          launch("project:couch"),
        )
        .pipe(Effect.flip);
      expect(refused.message).toContain("environment-couch isn't linked to this machine");
      expect((yield* Ref.get(boxSeen)).runs).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
