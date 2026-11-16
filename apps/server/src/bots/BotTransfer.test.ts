import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type BotTransferInput,
  CommandId,
  EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  OrchestratorMcpFailure,
  type PeerLink,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import type * as Tool from "effect/ai/Tool";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { CrewChangesLive } from "../crew/CrewChanges.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type { BotHome, BotProject, LinkBotImport } from "../mcp/toolkits/bots/linkTools.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as BotService from "./BotService.ts";
import * as BotStore from "./BotStore.ts";
import * as BotTransfer from "./BotTransfer.ts";

// The laptop moves or copies its bot Sky to the box. Each runs the real bot, project and
// automation services on its own database; the link between them is a fake that runs the box's
// link tools in process, and can refuse, or lose the answer after the box applied the call.

const laptop = { environmentId: EnvironmentId.make("environment-laptop"), label: "Laptop" };
const box = { environmentId: EnvironmentId.make("environment-box"), label: "Box" };
const couch = { environmentId: EnvironmentId.make("environment-couch"), label: "Couch" };
const NEW_ID = "bot-sky-on-box";

type Environment = { readonly environmentId: EnvironmentId; readonly label: string };
type Services =
  | BotTransfer.BotTransfer
  | BotService.BotService
  | ScheduledTaskService.ScheduledTaskService
  | ProjectService.ProjectService
  | BotStore.BotStore
  | SqlClient.SqlClient;

/** Each bot's home is a project at `<root>/<botId>`, a real folder so its files travel. */
const layerBotHomes = (root: string) =>
  Layer.effect(
    ManagedProjectFolders.ManagedProjectFolders,
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const fileSystem = yield* FileSystem.FileSystem;
      const isHome = (projectId: ProjectId) =>
        projects
          .getById(projectId, { includeDeleted: true })
          .pipe(
            Effect.map(Option.exists((project) => project.workspaceRoot.startsWith(`${root}/`))),
            Effect.orDie,
          );
      return ManagedProjectFolders.ManagedProjectFolders.of({
        namedProjectsRoot: "/projects",
        botHomesRoot: Effect.succeedSome(root),
        botHomePath: (botId: string) => Effect.succeedSome(`${root}/${botId}`),
        isScratchProject: () => Effect.succeed(false),
        isBotHome: isHome,
        isHiddenProject: isHome,
        ensureBotHome: (bot: { readonly id: string; readonly name: string }) =>
          fileSystem.makeDirectory(`${root}/${bot.id}`, { recursive: true }).pipe(
            Effect.andThen(
              projects.bootstrap({
                commandId: CommandId.make(`command:home:${bot.id}`),
                projectId: ProjectId.make(`project:home:${bot.id}`),
                title: bot.name,
                workspaceRoot: `${root}/${bot.id}`,
                botId: bot.id,
              }),
            ),
            Effect.map(({ project }) => ({
              projectId: project.id,
              workspaceRoot: project.workspaceRoot,
            })),
            Effect.orDie,
          ),
      } as unknown as ManagedProjectFolders.ManagedProjectFolders["Service"]);
    }),
  );

/** One environment's real services; `peers` stands in for its links. */
const layerEnvironment = (
  self: Environment,
  root: string,
  peers: {
    readonly links: Partial<PeerLinks.PeerLinks["Service"]>;
    readonly forwarding: Partial<PeerForwarding.PeerForwarding["Service"]>;
    /** Its bots' headquarters threads that have a turn running. */
    readonly working?: ReadonlyArray<string>;
    /** Whether another thread in a bot's home has a turn running. */
    readonly workingInHome?: boolean;
  },
) =>
  BotTransfer.layer.pipe(
    Layer.provideMerge(BotService.layer),
    Layer.provideMerge(CrewChangesLive),
    Layer.provideMerge(
      ScheduledTaskService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ManagedPolicy.layerTest(),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Scheduler.layer,
          ),
        ),
      ),
    ),
    Layer.provideMerge(layerBotHomes(root)),
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(BotStore.layer),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(
              (peers.working ?? []).includes(threadId)
                ? ({ id: threadId, activeRunId: "run:busy" } as never)
                : null,
            ),
          getShellSnapshot: () =>
            Effect.succeed({
              threads: peers.workingInHome === true ? [{ activeRunId: "run:feature" }] : [],
            } as never),
        }),
        Layer.mock(PeerLinks.PeerLinks)(peers.links),
        Layer.mock(PeerForwarding.PeerForwarding)(peers.forwarding),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed(self as never),
        }),
        Layer.succeed(WorkspacePaths.WorkspacePaths, {
          normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
          resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
            Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
        }),
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: () => Effect.succeed(null),
        }),
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          resolvePath: () => Effect.succeed(null),
          invalidate: () => Effect.void,
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "bot-transfer-test-" })),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const linkTo = (peer: Environment, access: PeerLink["access"] = "full-access"): PeerLink => ({
  environmentId: peer.environmentId,
  label: peer.label,
  urls: ["https://peer.example"],
  access,
  linkedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(Date.UTC(2999, 0, 1)),
  lastReachedAt: null,
  lastError: null,
});

/** Records a link row, which the bot store reads as where its bots may reach. */
const recordLink = (peer: Environment) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO peer_environment_links (
        environment_id, secret_name, label, urls_json, access, linked_at, expires_at
      ) VALUES (
        ${peer.environmentId}, 'secret', ${peer.label}, '[]', 'full-access', '2026-01-01', '2999-01-01'
      )
    `;
  });

/** What the fake link does with the next import, and the discard after it. */
interface Behavior {
  import: "apply" | "refuse" | "lose-answer" | "unknown-tool";
  discard: "apply" | "unanswered";
}

const lostAnswer = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "The linked environment stopped answering.",
});

const automation = (title: string, schedule: ScheduledTaskUpsertInput["schedule"]) =>
  ({
    title,
    prompt: "Post the weekly update",
    enabled: true,
    schedule,
    botId: "bot-sky",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
  }) satisfies ScheduledTaskUpsertInput;

/**
 * The laptop with Sky (a home file, a weekly automation and a webhook one, a project here) and
 * the box, which links back to the laptop and holds a project the laptop gave Sky.
 */
const setup = (
  options: {
    readonly capabilities?: ExecutionEnvironmentCapabilities;
    readonly linkAccess?: PeerLink["access"];
    readonly boxLinksBack?: boolean;
    readonly working?: ReadonlyArray<string>;
    readonly workingInHome?: boolean;
    /** A third machine, linked to both, holding a project Sky owns. */
    readonly withCouch?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "bot-transfer-" });
    const behavior: Behavior = { import: "apply", discard: "apply" };
    const calls: Array<string> = [];
    // The laptop's automations as the box's import began.
    const atImport: Array<{ readonly title: string; readonly enabled: boolean }> = [];
    const watch = { laptop: Effect.void as Effect.Effect<void> };

    const peer = (self: Environment) =>
      Layer.build(
        layerEnvironment(self, path.join(tmp, self.label.toLowerCase()), {
          links: { list: Effect.succeed([]) },
          forwarding: {},
        }),
      );
    const boxContext = yield* peer(box);
    const onBox = <A, E>(effect: Effect.Effect<A, E, Services>) =>
      effect.pipe(Effect.provide(boxContext));
    const boxTransfer = Context.get(boxContext, BotTransfer.BotTransfer);
    const couchContext = options.withCouch === true ? yield* peer(couch) : boxContext;
    const onCouch = <A, E>(effect: Effect.Effect<A, E, Services>) =>
      effect.pipe(Effect.provide(couchContext));
    const peers = new Map([
      [box.environmentId, { self: box, run: onBox }],
      [couch.environmentId, { self: couch, run: onCouch }],
    ]);

    const linkScope = (access: PeerLink["access"]): McpInvocationContext.McpInvocationScope => ({
      environmentId: box.environmentId,
      requestNamespace: "link:laptop",
      thread: undefined,
      client: { sessionId: "link:laptop", label: "Laptop", access, linked: true },
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    });
    const peerProjects = (self: Environment, run: typeof onBox, home: BotHome) =>
      run(
        ProjectService.ProjectService.pipe(
          Effect.flatMap((projects) => projects.snapshot),
          Effect.map((snapshot) =>
            snapshot.projects.flatMap((project): ReadonlyArray<BotProject> =>
              project.deletedAt === null &&
              project.remoteBot?.environmentId === home.environmentId &&
              project.remoteBot.botId === home.botId
                ? [
                    {
                      environmentId: self.environmentId,
                      environmentLabel: self.label,
                      projectId: project.id,
                      title: project.title,
                      workspaceRoot: project.workspaceRoot,
                      botId: home.botId,
                      openFeatures: [],
                    },
                  ]
                : [],
            ),
          ),
          Effect.orDie,
        ),
      );

    const call = (
      _scope: McpInvocationContext.McpInvocationScope,
      tool: Tool.Any,
      environmentId: EnvironmentId,
      params: unknown,
    ): Effect.Effect<unknown, OrchestratorMcpFailure> =>
      Effect.gen(function* () {
        const target = peers.get(environmentId)!;
        const scope = linkScope(options.linkAccess ?? "full-access");
        if (tool.name === "t3_bot_link_projects") {
          return {
            projects: yield* peerProjects(
              target.self,
              target.run,
              (params as { home: BotHome }).home,
            ),
          };
        }
        if (tool.name === "t3_bot_link_rehome") {
          calls.push(`rehome:${target.self.label}`);
          return yield* target.run(
            BotTransfer.BotTransfer.pipe(
              Effect.flatMap((service) => service.rehomeForLink(scope, params as never)),
            ),
          );
        }
        const input = params as Tool.Parameters<typeof LinkBotImport>;
        if (environmentId !== box.environmentId) {
          return yield* target.run(
            BotTransfer.BotTransfer.pipe(
              Effect.flatMap((service) => service.importForLink(scope, input)),
            ),
          );
        }
        const kind =
          input.discard === true ? "discard" : input.dryRun === true ? "check" : "import";
        calls.push(kind);
        if (kind === "discard" && behavior.discard === "unanswered") return yield* lostAnswer;
        if (kind === "import") {
          yield* watch.laptop;
          if (behavior.import === "refuse") {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Box refused the copy.",
            });
          }
          if (behavior.import === "unknown-tool") {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Tool 't3_bot_link_import' not found",
            });
          }
        }
        const answer = yield* boxTransfer.importForLink(scope, input);
        if (kind === "import" && behavior.import === "lose-answer") return yield* lostAnswer;
        return answer;
      });

    const laptopContext = yield* Layer.build(
      layerEnvironment(laptop, path.join(tmp, "laptop"), {
        links: {
          enabled: Effect.succeed(true),
          get: (id) =>
            Effect.succeed(
              id === box.environmentId
                ? Option.some(linkTo(box, options.linkAccess))
                : id === couch.environmentId && options.withCouch === true
                  ? Option.some(linkTo(couch))
                  : Option.none(),
            ),
          resolve: (id) =>
            Effect.succeed({
              link: id === couch.environmentId ? linkTo(couch) : linkTo(box, options.linkAccess),
              url: "https://peer.example",
              token: "fixture",
              capabilities: options.capabilities ?? { repositoryIdentity: true, botTransfer: true },
            }),
          list: Effect.succeed([
            { ...linkTo(box), status: "reachable" as const },
            ...(options.withCouch === true
              ? [{ ...linkTo(couch), status: "reachable" as const }]
              : []),
          ]),
        },
        forwarding: { call: call as PeerForwarding.PeerForwarding["Service"]["call"] },
        ...(options.working === undefined ? {} : { working: options.working }),
        ...(options.workingInHome === undefined ? {} : { workingInHome: options.workingInHome }),
      }),
    );
    const onLaptop = <A, E>(effect: Effect.Effect<A, E, Services>) =>
      effect.pipe(Effect.provide(laptopContext));

    yield* onLaptop(recordLink(box));
    if (options.boxLinksBack !== false) yield* onBox(recordLink(laptop));
    const couchProject = ProjectId.make("project:couch-notes");
    if (options.withCouch === true) {
      yield* onLaptop(recordLink(couch));
      yield* onBox(recordLink(couch));
      yield* onCouch(
        ProjectService.ProjectService.pipe(
          Effect.flatMap((projects) =>
            projects
              .bootstrap({
                commandId: CommandId.make("command:couch-notes"),
                projectId: couchProject,
                title: "Notes",
                workspaceRoot: "/home/notes",
              })
              .pipe(
                Effect.andThen(
                  projects.assignBot({
                    commandId: CommandId.make("command:couch-notes-sky"),
                    projectId: couchProject,
                    botId: null,
                    remoteBot: {
                      environmentId: laptop.environmentId,
                      botId: "bot-sky",
                      name: "Sky",
                      homeLabel: "Laptop",
                    },
                  }),
                ),
              ),
          ),
        ),
      );
    }

    // Sky on the laptop, with a note in its home, two automations and a project.
    const sky = yield* onLaptop(
      BotService.BotService.pipe(
        Effect.flatMap((bots) =>
          bots.create({
            id: "bot-sky",
            name: "Sky",
            avatar: {
              head: "round",
              eyes: "happy",
              face: "plate",
              top: "bow",
              cheeks: true,
              smile: false,
            },
            color: "pink",
            instructions: "Post updates.",
            withheldTools: ["preview"],
            longConversation: "new-session",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          }),
        ),
      ),
    );
    yield* fileSystem.makeDirectory(path.join(sky.homePath!, "memory"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(sky.homePath!, "memory", "notes.md"), "Be brief.");
    yield* onLaptop(
      ScheduledTaskService.ScheduledTaskService.pipe(
        Effect.flatMap((tasks) =>
          Effect.all([
            tasks.upsert(automation("Weekly update", { type: "interval", everyMs: 3_600_000 })),
            tasks.upsert(automation("Deploy hook", { type: "webhook", signature: null })),
          ]),
        ),
      ),
    );
    const laptopProject = ProjectId.make("project:laptop-site");
    const boxProject = ProjectId.make("project:box-api");
    yield* onLaptop(
      ProjectService.ProjectService.pipe(
        Effect.flatMap((projects) =>
          projects.bootstrap({
            commandId: CommandId.make("command:laptop-site"),
            projectId: laptopProject,
            title: "Site",
            workspaceRoot: "/work/site",
            botId: "bot-sky",
          }),
        ),
      ),
    );
    yield* onBox(
      ProjectService.ProjectService.pipe(
        Effect.flatMap((projects) =>
          projects
            .bootstrap({
              commandId: CommandId.make("command:box-api"),
              projectId: boxProject,
              title: "API",
              workspaceRoot: "/srv/api",
            })
            .pipe(
              Effect.andThen(
                projects.assignBot({
                  commandId: CommandId.make("command:box-api-sky"),
                  projectId: boxProject,
                  botId: null,
                  remoteBot: {
                    environmentId: laptop.environmentId,
                    botId: "bot-sky",
                    name: "Sky",
                    homeLabel: "Laptop",
                  },
                }),
              ),
            ),
        ),
      ),
    );

    const laptopTasks = onLaptop(
      ScheduledTaskService.ScheduledTaskService.pipe(
        Effect.flatMap((tasks) => tasks.list()),
        Effect.map((listed) => listed.tasks),
      ),
    );
    watch.laptop = laptopTasks.pipe(
      Effect.map(
        (tasks) => void atImport.push(...tasks.map(({ title, enabled }) => ({ title, enabled }))),
      ),
      Effect.orDie,
    );
    const transfer = (
      mode: BotTransferInput["mode"],
      dryRun = false,
      overrides: {
        readonly target?: EnvironmentId;
        readonly newBotId?: string;
        readonly cancelMove?: "undo" | "forget";
      } = {},
    ) =>
      onLaptop(
        BotTransfer.BotTransfer.pipe(
          Effect.flatMap((service) =>
            service.transfer({
              botId: "bot-sky",
              targetEnvironmentId: overrides.target ?? box.environmentId,
              newBotId: overrides.newBotId ?? NEW_ID,
              mode,
              ...(dryRun ? { dryRun } : {}),
              ...(overrides.cancelMove === undefined ? {} : { cancelMove: overrides.cancelMove }),
            }),
          ),
        ),
      );
    return {
      sky,
      behavior,
      calls,
      atImport,
      transfer,
      onLaptop,
      onBox,
      onCouch,
      couchProject,
      laptopRoot: path.join(tmp, "laptop"),
      chmod: (file: string, mode: number) => fileSystem.chmod(file, mode),
      boxTransfer,
      linkScope,
      laptopProject,
      boxProject,
      laptopTasks,
      boxTasks: onBox(
        ScheduledTaskService.ScheduledTaskService.pipe(
          Effect.flatMap((tasks) => tasks.list()),
          Effect.map((listed) => listed.tasks),
        ),
      ),
      getBot: (on: typeof onLaptop, id: string) =>
        on(BotService.BotService.pipe(Effect.flatMap((bots) => bots.get(id)))),
      getProject: (on: typeof onLaptop, id: ProjectId) =>
        on(
          ProjectService.ProjectService.pipe(
            Effect.flatMap((projects) => projects.getById(id)),
            Effect.map(Option.getOrThrow),
          ),
        ),
      exists: (file: string) => fileSystem.exists(file),
      read: (file: string) => fileSystem.readFileString(file),
    };
  });

const sortedTasks = <T extends { readonly title: string }>(tasks: ReadonlyArray<T>) =>
  tasks.toSorted((left, right) => left.title.localeCompare(right.title));

/** The laptop's Sky, its automations and its project, just as they were set up. */
const assertLaptopUnchanged = (env: Effect.Success<ReturnType<typeof setup>>) =>
  Effect.gen(function* () {
    const sky = yield* env.getBot(env.onLaptop, "bot-sky");
    assert.equal(sky?.revision, 1);
    assert.deepEqual(
      sortedTasks(yield* env.laptopTasks).map((task) => [
        task.title,
        task.enabled,
        task.pausedReason,
      ]),
      [
        ["Deploy hook", true, undefined],
        ["Weekly update", true, undefined],
      ],
    );
    assert.equal((yield* env.getProject(env.onLaptop, env.laptopProject)).botId, "bot-sky");
  });

it.layer(Layer.mergeAll(NodeServices.layer))("BotTransfer", (it) => {
  it.effect("copies a bot with its home files and automations turned off", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const preview = yield* env.transfer("copy", true);
      assert.deepEqual(
        preview.projects.map((project) => [project.title, project.outcome]).toSorted(),
        [
          ["API", "stays-with-original"],
          ["Site", "stays-with-original"],
        ],
      );
      assert.deepEqual(preview.automations, {
        copied: 2,
        enabled: 1,
        needAttention: [{ title: "Deploy hook", reason: BotTransfer.webhookReason("Box") }],
      });

      yield* env.transfer("copy");
      const copy = yield* env.getBot(env.onBox, NEW_ID);
      assert.deepEqual(
        copy && {
          name: copy.name,
          color: copy.color,
          instructions: copy.instructions,
          withheldTools: copy.withheldTools,
          longConversation: copy.longConversation,
          modelSelection: copy.modelSelection,
        },
        {
          name: "Sky",
          color: "pink",
          instructions: "Post updates.",
          withheldTools: ["preview"],
          longConversation: "new-session",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        },
      );
      assert.equal(yield* env.read(`${copy!.homePath}/memory/notes.md`), "Be brief.");
      assert.deepEqual(
        sortedTasks(yield* env.boxTasks).map((task) => [
          task.title,
          task.enabled,
          task.pausedReason,
        ]),
        [
          ["Deploy hook", false, BotTransfer.webhookReason("Box")],
          ["Weekly update", false, "Copied from Laptop. Turn it on when you're ready."],
        ],
      );
      // The original stays as it was, and keeps its projects and running automations.
      yield* assertLaptopUnchanged(env);
      assert.equal((yield* env.getProject(env.onBox, env.boxProject)).remoteBot?.botId, "bot-sky");
    }),
  );

  it.effect("moves a bot: the copy takes over, and nothing of it stays behind", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const preview = yield* env.transfer("move", true);
      assert.deepEqual(
        preview.projects.map((project) => [project.title, project.outcome]).toSorted(),
        [
          ["API", "comes-along"],
          ["Site", "comes-along"],
        ],
      );

      yield* env.transfer("move");
      // Its automations stopped on the laptop before the box could start them.
      assert.deepEqual(
        env.atImport.map((task) => task.enabled),
        [false, false],
      );
      const moved = yield* env.getBot(env.onBox, NEW_ID);
      assert.equal(moved?.name, "Sky");
      assert.equal(yield* env.read(`${moved!.homePath}/memory/notes.md`), "Be brief.");
      assert.deepEqual(
        sortedTasks(yield* env.boxTasks).map((task) => [
          task.title,
          task.enabled,
          task.pausedReason,
        ]),
        [
          ["Deploy hook", false, BotTransfer.webhookReason("Box")],
          ["Weekly update", true, undefined],
        ],
      );
      assert.equal((yield* env.getProject(env.onBox, env.boxProject)).botId, NEW_ID);
      // The box links back, so the laptop's project is the moved Sky's over the link.
      const site = yield* env.getProject(env.onLaptop, env.laptopProject);
      assert.deepEqual(
        [site.botId, site.remoteBot],
        [null, { environmentId: box.environmentId, botId: NEW_ID, name: "Sky", homeLabel: "Box" }],
      );
      // Nothing of Sky stays on the laptop: no bot, automations, home, thread or folder.
      assert.isNull(yield* env.getBot(env.onLaptop, "bot-sky"));
      assert.deepEqual(yield* env.laptopTasks, []);
      assert.isFalse(yield* env.exists(env.sky.homePath!));
      const home = yield* env.onLaptop(
        ProjectService.ProjectService.pipe(
          Effect.flatMap((projects) => projects.getByWorkspaceRoot(env.sky.homePath!)),
        ),
      );
      assert.isTrue(Option.isNone(home));
    }),
  );

  it.effect("leaves projects with no bot when the target can't reach their machine", () =>
    Effect.gen(function* () {
      const env = yield* setup({ boxLinksBack: false });
      const preview = yield* env.transfer("move", true);
      assert.deepEqual(
        preview.projects.map((project) => [project.title, project.outcome]).toSorted(),
        [
          ["API", "comes-along"],
          ["Site", "left-without-bot"],
        ],
      );
      yield* env.transfer("move");
      const site = yield* env.getProject(env.onLaptop, env.laptopProject);
      assert.deepEqual([site.botId, site.remoteBot], [null, null]);
    }),
  );

  it.effect("a move the box refuses leaves the bot where it was, automations back on", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      env.behavior.import = "refuse";
      const refused = yield* env.transfer("move").pipe(Effect.flip);
      assert.equal(refused.message, "Box refused the copy.");
      yield* assertLaptopUnchanged(env);
      assert.isNull(yield* env.getBot(env.onBox, NEW_ID));
      assert.equal((yield* env.getProject(env.onBox, env.boxProject)).remoteBot?.botId, "bot-sky");
    }),
  );

  it.effect("a lost answer is undone on the box when it confirms the discard", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      env.behavior.import = "lose-answer";
      yield* env.transfer("move").pipe(Effect.flip);
      assert.deepEqual(env.calls, ["check", "import", "discard"]);
      yield* assertLaptopUnchanged(env);
      // The box applied the import, then gave it all back and freed the ID.
      assert.isNull(yield* env.getBot(env.onBox, NEW_ID));
      assert.deepEqual(yield* env.boxTasks, []);
      assert.equal((yield* env.getProject(env.onBox, env.boxProject)).remoteBot?.botId, "bot-sky");
      assert.isFalse(
        yield* env.onBox(BotStore.BotStore.pipe(Effect.flatMap((store) => store.idTaken(NEW_ID)))),
      );
    }),
  );

  it.effect("an unconfirmed move holds its target and ID until a retry finishes it", () =>
    Effect.gen(function* () {
      const env = yield* setup({ withCouch: true });
      env.behavior.import = "lose-answer";
      env.behavior.discard = "unanswered";
      const failed = yield* env.transfer("move").pipe(Effect.flip);
      assert.equal(
        failed.message,
        "Couldn't confirm with Box. Sky's automations stay paused here, because Box may already run them; don't turn them on here. Move Sky to Box again to finish.",
      );
      const paused = sortedTasks(yield* env.laptopTasks);
      assert.deepEqual(
        paused.map((task) => [task.enabled, task.pausedReason]),
        [
          [false, "Moving to Box"],
          [false, "Moving to Box"],
        ],
      );
      // The box may already run them, so they stay off here until the move is settled.
      const turnedOn = yield* env
        .onLaptop(
          ScheduledTaskService.ScheduledTaskService.pipe(
            Effect.flatMap((tasks) => tasks.setEnabled({ id: paused[1]!.id, enabled: true })),
          ),
        )
        .pipe(Effect.flip);
      assert.include(turnedOn.message, "Sky is moving to another machine");
      // Nor can it go somewhere else meanwhile.
      const elsewhere = yield* env
        .transfer("move", false, { target: couch.environmentId })
        .pipe(Effect.flip);
      assert.equal(
        elsewhere.message,
        "Sky's move to Box hasn't finished. Move it to Box again to finish it first.",
      );

      // A retry from a fresh dialog, under a new ID, finishes the same move.
      env.behavior.import = "apply";
      env.behavior.discard = "apply";
      const finished = yield* env.transfer("move", false, { newBotId: "bot-fresh-dialog" });
      assert.equal(finished.bot.id, NEW_ID);
      assert.isNull(yield* env.getBot(env.onLaptop, "bot-sky"));
      const onBox = yield* env.onBox(
        BotService.BotService.pipe(Effect.flatMap((bots) => bots.list)),
      );
      assert.deepEqual(
        onBox.map((bot) => bot.id),
        [NEW_ID],
      );
      // The retry counted the automations it had paused as on.
      assert.deepEqual(
        sortedTasks(yield* env.boxTasks).map((task) => [task.title, task.enabled]),
        [
          ["Deploy hook", false],
          ["Weekly update", true],
        ],
      );
    }),
  );

  it.effect("Cancel move undoes the copy on the box and turns the automations back on", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      env.behavior.import = "lose-answer";
      env.behavior.discard = "unanswered";
      yield* env.transfer("move").pipe(Effect.flip);
      assert.equal((yield* env.getBot(env.onLaptop, "bot-sky"))?.movingTo, box.environmentId);

      env.behavior.discard = "apply";
      const cancelled = yield* env.transfer("move", false, { cancelMove: "undo" });
      assert.deepEqual(cancelled.warnings, []);
      assert.isNull((yield* env.getBot(env.onLaptop, "bot-sky"))?.movingTo);
      yield* assertLaptopUnchanged(env);
      assert.isNull(yield* env.getBot(env.onBox, NEW_ID));
      assert.deepEqual(yield* env.boxTasks, []);
      assert.equal((yield* env.getProject(env.onBox, env.boxProject)).remoteBot?.botId, "bot-sky");
    }),
  );

  it.effect("Cancel move without the box keeps automations off and frees the bot to move", () =>
    Effect.gen(function* () {
      const env = yield* setup({ withCouch: true });
      env.behavior.import = "lose-answer";
      env.behavior.discard = "unanswered";
      yield* env.transfer("move").pipe(Effect.flip);

      // Undoing needs the box; it's gone quiet, so the person has to choose to stop waiting.
      const needsBox = yield* env.transfer("move", false, { cancelMove: "undo" }).pipe(Effect.flip);
      assert.equal(
        needsBox.message,
        "Box didn't answer, so Sky's copy there couldn't be undone. Box may still run Sky's automations.",
      );
      const forgotten = yield* env.transfer("move", false, { cancelMove: "forget" });
      assert.deepEqual(forgotten.warnings, [
        "Box didn't answer, so it may still run Sky's automations. They stay off here; turn them on only once you're sure Box doesn't.",
      ]);
      const tasks = sortedTasks(yield* env.laptopTasks);
      assert.deepEqual(
        tasks.map((task) => [task.enabled, task.pausedReason]),
        [
          [
            false,
            "Box may still run this from a cancelled move. Turn it on here only once you're sure it doesn't.",
          ],
          [
            false,
            "Box may still run this from a cancelled move. Turn it on here only once you're sure it doesn't.",
          ],
        ],
      );
      assert.isNull((yield* env.getBot(env.onLaptop, "bot-sky"))?.movingTo);
      // The person may turn them on again, and move Sky elsewhere.
      yield* env.onLaptop(
        ScheduledTaskService.ScheduledTaskService.pipe(
          Effect.flatMap((service) => service.setEnabled({ id: tasks[1]!.id, enabled: true })),
        ),
      );
      const elsewhere = yield* env.transfer("move", true, { target: couch.environmentId });
      assert.equal(elsewhere.bot.environmentId, couch.environmentId);
    }),
  );

  it.effect("a removal that fails part-way leaves the bot for a retry to finish", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      // Sky's home folder can't leave the laptop's bots folder.
      yield* env.chmod(env.laptopRoot, 0o555);
      const failed = yield* env.transfer("move").pipe(Effect.flip);
      yield* env.chmod(env.laptopRoot, 0o755);
      assert.include(failed.message, "Moved Sky to Box, but couldn't remove it from Laptop");
      assert.isNotNull(yield* env.getBot(env.onLaptop, "bot-sky"));

      yield* env.transfer("move", false, { newBotId: "bot-fresh-dialog" });
      assert.isNull(yield* env.getBot(env.onLaptop, "bot-sky"));
      assert.isFalse(yield* env.exists(env.sky.homePath!));
      assert.deepEqual(yield* env.laptopTasks, []);
      assert.equal((yield* env.getProject(env.onBox, env.boxProject)).botId, NEW_ID);
    }),
  );

  it.effect("a failed copy is undone on the box, and the original keeps running", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      env.behavior.import = "lose-answer";
      const failed = yield* env.transfer("copy").pipe(Effect.flip);
      assert.equal(failed.message, "The linked environment stopped answering.");
      assert.deepEqual(env.calls, ["check", "import", "discard"]);
      assert.isNull(yield* env.getBot(env.onBox, NEW_ID));
      assert.deepEqual(yield* env.boxTasks, []);
      yield* assertLaptopUnchanged(env);
    }),
  );

  it.effect("a move hands a third machine's projects to the moved bot", () =>
    Effect.gen(function* () {
      const env = yield* setup({ withCouch: true });
      const preview = yield* env.transfer("move", true);
      assert.deepEqual(
        preview.projects.map((project) => [project.title, project.outcome]).toSorted(),
        [
          ["API", "comes-along"],
          ["Notes", "comes-along"],
          ["Site", "comes-along"],
        ],
      );
      const moved = yield* env.transfer("move");
      assert.deepEqual(moved.warnings, []);
      assert.include(env.calls, "rehome:Couch");
      assert.deepEqual((yield* env.getProject(env.onCouch, env.couchProject)).remoteBot, {
        environmentId: box.environmentId,
        botId: NEW_ID,
        name: "Sky",
        homeLabel: "Box",
      });
    }),
  );

  it.effect("the box never undoes or takes over a bot it didn't copy", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      // The box has a Sky of its own that happens to use the ID.
      yield* env.onBox(
        BotService.BotService.pipe(
          Effect.flatMap((bots) =>
            bots.create({ id: NEW_ID, name: "Sky", avatar: env.sky.avatar, color: env.sky.color }),
          ),
        ),
      );
      const input = {
        home: {
          environmentId: laptop.environmentId,
          botId: "bot-sky",
          botName: "Sky",
          label: "Laptop",
        },
        newBotId: NEW_ID,
        mode: "move" as const,
        bot: env.sky,
        homeFiles: [],
        automations: [],
      };
      const undone = yield* env.boxTransfer.importForLink(env.linkScope("full-access"), {
        ...input,
        discard: true,
      });
      assert.isFalse(undone.undone);
      const refused = yield* env.boxTransfer
        .importForLink(env.linkScope("full-access"), input)
        .pipe(Effect.flip);
      assert.equal(refused.message, `Bot ID ${NEW_ID} is already in use here.`);
      const move = yield* env.transfer("move").pipe(Effect.flip);
      assert.equal(move.message, `Bot ID ${NEW_ID} is already in use here.`);
      assert.isNotNull(yield* env.getBot(env.onBox, NEW_ID));
      yield* assertLaptopUnchanged(env);
    }),
  );

  it.effect("an older Bosun on the target is refused by name, before anything changes", () =>
    Effect.gen(function* () {
      const older = yield* setup({ capabilities: { repositoryIdentity: true } });
      const refused = yield* older.transfer("move").pipe(Effect.flip);
      assert.equal(refused.message, "Update Bosun on Box to copy bots to it.");
      assert.deepEqual(older.calls, []);
      yield* assertLaptopUnchanged(older);

      // One that says it can but has no such tool is refused the same way, with nothing lost.
      const unknown = yield* setup();
      unknown.behavior.import = "unknown-tool";
      const alsoRefused = yield* unknown.transfer("move").pipe(Effect.flip);
      assert.equal(alsoRefused.message, "Update Bosun on Box to copy bots to it.");
      yield* assertLaptopUnchanged(unknown);
    }),
  );

  it.effect("refuses a link below full access and a bot mid-turn", () =>
    Effect.gen(function* () {
      const limited = yield* setup({ linkAccess: "auto" });
      const refused = yield* limited.transfer("copy").pipe(Effect.flip);
      assert.include(refused.message, "Link Box again with full access");
      // The box refuses such a link too.
      const denied = yield* limited.boxTransfer
        .importForLink(limited.linkScope("auto"), {
          home: {
            environmentId: laptop.environmentId,
            botId: "bot-sky",
            botName: "Sky",
            label: "Laptop",
          },
          newBotId: NEW_ID,
          mode: "copy",
          bot: limited.sky,
          homeFiles: [],
          automations: [],
        })
        .pipe(Effect.flip);
      assert.equal(denied.code, "capability_denied");

      const working = yield* setup({ working: [ThreadId.make("bot-run:bot-hq:bot-sky")] });
      const busy = yield* working.transfer("move").pipe(Effect.flip);
      assert.equal(busy.message, "Sky is working. Wait for it or stop it, then move.");
      // Any turn in its home counts, not only its headquarters'.
      const inHome = yield* setup({ workingInHome: true });
      const alsoBusy = yield* inHome.transfer("move").pipe(Effect.flip);
      assert.equal(alsoBusy.message, "Sky is working. Wait for it or stop it, then move.");
    }),
  );

  it.effect("the box's import is idempotent on the new ID, and discard gives projects back", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const input = {
        home: {
          environmentId: laptop.environmentId,
          botId: "bot-sky",
          botName: "Sky",
          label: "Laptop",
        },
        newBotId: NEW_ID,
        mode: "move" as const,
        bot: env.sky,
        homeFiles: [],
        automations: [],
      };
      yield* env.boxTransfer.importForLink(env.linkScope("full-access"), input);
      // Renamed on the box since, it's still the same copy.
      yield* env.onBox(
        BotService.BotService.pipe(
          Effect.flatMap((bots) =>
            bots.update({ id: NEW_ID, expectedRevision: 1, name: "Sky on the box" }),
          ),
        ),
      );
      yield* env.boxTransfer.importForLink(env.linkScope("full-access"), input);
      const listed = yield* env.onBox(
        BotService.BotService.pipe(Effect.flatMap((bots) => bots.list)),
      );
      assert.deepEqual(
        listed.map((bot) => bot.id),
        [NEW_ID],
      );
      assert.equal((yield* env.getProject(env.onBox, env.boxProject)).botId, NEW_ID);

      const undone = yield* env.boxTransfer.importForLink(env.linkScope("full-access"), {
        ...input,
        discard: true,
      });
      assert.isTrue(undone.undone);
      assert.deepEqual((yield* env.getProject(env.onBox, env.boxProject)).remoteBot, {
        environmentId: laptop.environmentId,
        botId: "bot-sky",
        name: "Sky",
        homeLabel: "Laptop",
      });
    }),
  );
});
