import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  type Bot,
  botHeadquartersThreadId,
  CAPTAIN_BOT_ID,
  type Project,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import type { CreateCrewRunInput } from "../crew/CrewService.ts";
import { CrewService } from "../crew/CrewService.ts";
import { CrewStore } from "../crew/CrewStore.ts";
import { FeatureService } from "../features/FeatureService.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../peer/PeerLinks.testkit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { TicketService } from "../tickets/TicketService.ts";
import * as BotReach from "./BotReach.ts";
import * as BotService from "./BotService.ts";

// Captain on the laptop reaches the projects its namesake owns on a linked box: both are real
// /mcp toolkits and real BotReach, the box behind real OAuth, with their data mocked.

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const couch = descriptorOf("environment-couch", "Couch");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const bot = (id: string, name: string, position: number): Bot => ({
  id,
  name,
  avatar: { head: "round", face: "visor", eyes: "round", top: "none", cheeks: false, smile: true },
  color: "blue",
  instructions: "",
  allowedTools: [],
  runtimeMode: "full-access",
  modelSelection,
  longConversation: "compact",
  position,
  revision: 1,
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
});
const project = (id: string, title: string, botId: string) =>
  ({
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/home/user/${title}`,
    botId,
    deletedAt: null,
  }) as unknown as Project;

interface Environment {
  readonly bots: ReadonlyArray<Bot>;
  readonly projects: ReadonlyArray<Project>;
}

/** What one environment's services were asked to change. */
interface Seen {
  readonly moves: ReadonlyArray<{ readonly projectId: string; readonly botId: string }>;
  readonly runs: ReadonlyArray<CreateCrewRunInput>;
}

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
    Layer.mock(CrewService)({
      ensureProjectManager: (projectId) =>
        Effect.succeed({ id: `bot-manager:${projectId}` } as never),
      createRun: (input) =>
        Ref.update(seen, (current) => ({ ...current, runs: [...current.runs, input] })).pipe(
          Effect.as({
            threadId: `bot-run:${input.id}`,
            modelSelection: input.carried?.modelSelection,
          } as never),
        ),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([
        {
          instanceId: modelSelection.instanceId,
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: modelSelection.model }],
        },
      ] as never),
    }),
    Layer.mock(GitWorkflowService)({ currentBranch: () => Effect.succeed("main") }),
  );

/** The crew toolkits and what they read besides BotReach's data. */
const layerToolServices = Layer.mergeAll(
  Layer.mock(CrewStore)({}),
  Layer.mock(IssueService.IssueService)({}),
  Layer.mock(TicketService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(liveThreadShell(threadId, { runtimeMode: "full-access" })),
  }),
);

const boxData: Environment = {
  bots: [bot(CAPTAIN_BOT_ID, "Captain", 0), bot("bot:social-box", "Social", 1)],
  projects: [
    project("project:omni", "omni-mono", CAPTAIN_BOT_ID),
    project("project:blog", "blog", "bot:social-box"),
  ],
};

/** The box: its real /mcp with the crew toolkits and real BotReach. */
const serveBox = (seen: Ref.Ref<Seen>) =>
  servePeer(
    box,
    McpHttpServer.layerCrewTools.pipe(
      Layer.provide(BotReach.layer),
      Layer.provide(layerData(boxData, seen)),
      Layer.provide(layerToolServices),
      Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
      Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
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

const headquarters = botHeadquartersThreadId(CAPTAIN_BOT_ID);
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
  crewGrants: ["crew.workflows"],
};

/** The laptop: Captain's headquarters calls its own crew toolkits, which reach its links. */
const makeLaptop = Effect.gen(function* () {
  const seen = yield* Ref.make<Seen>({ moves: [], runs: [] });
  const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
  const here = yield* McpHttpServer.layerCrewTools.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(BotReach.layer),
    Layer.provide(
      layerData(
        {
          bots: [bot(CAPTAIN_BOT_ID, "Captain", 0)],
          projects: [project("project:laptop", "laptop-app", CAPTAIN_BOT_ID)],
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
  return {
    links: Context.get(linking, PeerLinks.PeerLinks),
    reach: Context.get(here, BotReach.BotReach),
    call: (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, headquartersScope),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
        ),
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

const launch = (projectId: string, model = modelSelection.model) => ({
  projectId: ProjectId.make(projectId),
  task: "Start a feature: dark mode.",
  title: "Dark mode",
  modelSelection: { ...modelSelection, model },
  runtimeMode: "full-access" as const,
  clientRequestId: `delegate:${projectId}:${model}`,
});

it.effect("Captain here lists, sees and takes its projects on a linked environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const boxSeen = yield* Ref.make<Seen>({ moves: [], runs: [] });
      const b = yield* serveBox(boxSeen);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "full-access");
      yield* linkSleepingCouch(a.links);

      const listed = yield* a.call("t3_bot_projects", {});
      expect(listed.isError, JSON.stringify(listed.content)).toBe(false);
      expect(listed.structuredContent).toMatchObject({
        bot: { id: CAPTAIN_BOT_ID, name: "Captain" },
        projects: [
          { environmentId: laptop.environmentId, projectId: "project:laptop", openFeatures: [] },
          {
            environmentId: box.environmentId,
            environmentLabel: "Box",
            projectId: "project:omni",
            title: "omni-mono",
            botId: CAPTAIN_BOT_ID,
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
      expect(asleep).toMatchObject({ reachable: false });
      expect(asleep?.lastReachedAt).toEqual(expect.any(String));

      const bots = yield* a.call("t3_bot_list", { environmentId: box.environmentId });
      expect(bots.isError, JSON.stringify(bots.content)).toBe(false);
      expect(bots.structuredContent).toMatchObject({
        bots: [{ id: CAPTAIN_BOT_ID }, { id: "bot:social-box", name: "Social" }],
      });
      const moved = yield* a.call("t3_bot_move_project", {
        environmentId: box.environmentId,
        projectId: "project:blog",
        botId: CAPTAIN_BOT_ID,
      });
      expect(moved.isError, JSON.stringify(moved.content)).toBe(false);
      expect((yield* Ref.get(boxSeen)).moves).toEqual([
        { projectId: "project:blog", botId: CAPTAIN_BOT_ID },
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("starts the project manager there, or says before starting anything why not", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const boxSeen = yield* Ref.make<Seen>({ moves: [], runs: [] });
      const b = yield* serveBox(boxSeen);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "full-access");
      const start = (input: ReturnType<typeof launch>) =>
        a.reach
          .launchProjectManager(headquartersScope, box.environmentId, CAPTAIN_BOT_ID, input)
          .pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );

      const launched = yield* a.reach.launchProjectManager(
        headquartersScope,
        box.environmentId,
        CAPTAIN_BOT_ID,
        launch("project:omni"),
      );
      expect(launched.threadId).toMatch(/^bot-run:link-task:/);
      expect((yield* Ref.get(boxSeen)).runs).toMatchObject([
        {
          memberId: "bot-manager:project:omni",
          projectId: "project:omni",
          taskText: "Start a feature: dark mode.",
          carried: { runtimeMode: "full-access", modelSelection },
          workspace: { branch: expect.stringMatching(/^bosun\/dark-mode-/), baseRef: "main" },
        },
      ]);

      expect(yield* start(launch("project:blog"))).toContain(
        "blog on Box belongs to Social, not Captain",
      );
      expect(yield* start(launch("project:omni", "gpt-elsewhere"))).toContain(
        "runs on gpt-elsewhere (codex), which isn't available on Box",
      );
      expect((yield* Ref.get(boxSeen)).runs).toHaveLength(1);

      yield* linkSleepingCouch(a.links);
      const asleep = yield* a.reach
        .launchProjectManager(
          headquartersScope,
          couch.environmentId,
          CAPTAIN_BOT_ID,
          launch("project:couch"),
        )
        .pipe(Effect.flip);
      expect(asleep.message).toMatch(
        /project:couch is on Couch, which isn't reachable \(last reached/,
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses a bot's project work over a link below full access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const boxSeen = yield* Ref.make<Seen>({ moves: [], runs: [] });
      const b = yield* serveBox(boxSeen);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");

      const refused = yield* a.reach
        .launchProjectManager(
          headquartersScope,
          box.environmentId,
          CAPTAIN_BOT_ID,
          launch("project:omni"),
        )
        .pipe(Effect.flip);
      expect(refused.message).toContain("Link Box again with full access");
      expect((yield* Ref.get(boxSeen)).runs).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
