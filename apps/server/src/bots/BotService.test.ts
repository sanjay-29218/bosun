import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CAPTAIN_BOT_ID,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as BotService from "./BotService.ts";
import { CrewChanges, CrewChangesLive } from "../crew/CrewChanges.ts";
import * as BotStore from "./BotStore.ts";

const layer = BotService.layer.pipe(
  Layer.provideMerge(CrewChangesLive),
  Layer.provideMerge(
    ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          Scheduler.layer,
        ),
      ),
    ),
  ),
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provideMerge(BotStore.layer),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(
    Layer.mergeAll(
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
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "bot-service-test-" })),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const automation = (title: string, botId: string | null): ScheduledTaskUpsertInput => ({
  title,
  prompt: "Post the weekly update",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("project:automations"),
  botId,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
});

const social = {
  id: "bot:social",
  name: "Social",
  avatar: { head: "round", eyes: "happy", face: "plate", top: "bow", cheeks: true, smile: false },
  color: "pink",
} as const;

it.layer(layer)("BotService", (it) => {
  it.effect("creates bots on the rail, idempotently, and reorders them", () =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const changes = yield* CrewChanges;
      const before = (yield* changes.revision).bots;
      const created = yield* bots.create(social);
      // Clients re-read the bots when their count moves, whoever created one.
      assert.strictEqual((yield* changes.revision).bots, before + 1);
      assert.deepStrictEqual(yield* bots.create(social), created);
      assert.strictEqual(created.position, 1);
      assert.strictEqual(created.modelSelection, null);
      const counted = (yield* changes.revision).bots;
      const conflict = yield* Effect.exit(bots.create({ ...social, name: "Other" }));
      assert.isTrue(Exit.isFailure(conflict));
      assert.strictEqual((yield* changes.revision).bots, counted);
      // Bots and crew members act in the same runs, so they can't share an ID.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO crew_members (id, name, instructions, allowed_tools_json,
          model_selection_json, runtime_mode, created_at, updated_at)
        VALUES ('member:taken', 'Taken', 'x', '[]', '{}', 'auto', '2026-10-01', '2026-10-01')
      `;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(bots.create({ ...social, id: "member:taken" }))),
      );

      const finance = yield* bots.create({
        id: "bot:finance",
        name: "Finance",
        avatar: {
          head: "wide",
          eyes: "visor",
          face: "visor",
          top: "headphones",
          cheeks: false,
          smile: false,
        },
        color: "green",
      });
      assert.deepStrictEqual(
        (yield* bots.list).map((bot) => bot.id),
        [CAPTAIN_BOT_ID, social.id, finance.id],
      );
      const reordered = yield* bots.reorder([finance.id, CAPTAIN_BOT_ID, social.id]);
      assert.deepStrictEqual(
        reordered.map((bot) => [bot.id, bot.position]),
        [
          [finance.id, 0],
          [CAPTAIN_BOT_ID, 1],
          [social.id, 2],
        ],
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(bots.reorder([finance.id, social.id]))));
    }),
  );

  it.effect("updates against the current revision only", () =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const bot = yield* bots.create({ ...social, id: "bot:update" });
      const renamed = yield* bots.update({ id: bot.id, expectedRevision: 1, name: "Socials" });
      assert.strictEqual(renamed.name, "Socials");
      assert.deepStrictEqual(renamed.avatar, social.avatar);
      assert.strictEqual(renamed.revision, 2);
      const stale = yield* Effect.exit(bots.update({ id: bot.id, expectedRevision: 1, name: "X" }));
      assert.isTrue(Exit.isFailure(stale));
    }),
  );

  it.effect("gives new projects to Captain or the requested bot, and moves them", () =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const projects = yield* ProjectService.ProjectService;
      const bot = yield* bots.create({ ...social, id: "bot:owner" });
      const captainProject = yield* projects.create({
        commandId: CommandId.make("command:captain-project"),
        projectId: ProjectId.make("project:captain"),
        title: "Captain's",
        workspaceRoot: "/work/captain",
      });
      assert.strictEqual(captainProject.botId, CAPTAIN_BOT_ID);
      const owned = yield* projects.create({
        commandId: CommandId.make("command:owned-project"),
        projectId: ProjectId.make("project:owned"),
        title: "Owned",
        workspaceRoot: "/work/owned",
        botId: bot.id,
      });
      assert.strictEqual(owned.botId, bot.id);
      const unknown = yield* Effect.exit(
        projects.create({
          commandId: CommandId.make("command:unknown-bot"),
          projectId: ProjectId.make("project:unknown"),
          title: "Unknown",
          workspaceRoot: "/work/unknown",
          botId: "bot:missing",
        }),
      );
      assert.isTrue(Exit.isFailure(unknown));

      // Deleting is refused while the bot owns a project, and allowed once it is moved.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(bots.delete(bot.id))));
      const moved = yield* bots.moveProject({ projectId: owned.id, botId: CAPTAIN_BOT_ID });
      assert.strictEqual(moved.botId, CAPTAIN_BOT_ID);
      const shell = yield* projects.getShell(owned.id);
      assert.strictEqual(shell._tag === "Some" ? shell.value.botId : null, CAPTAIN_BOT_ID);
      yield* bots.delete(bot.id);
      assert.strictEqual(yield* bots.get(bot.id), null);
      assert.isFalse((yield* bots.list).some((listed) => listed.id === bot.id));
      // The row stays, so runs it already started can still act, and its ID stays taken.
      const store = yield* BotStore.BotStore;
      assert.isTrue(yield* store.idTaken(bot.id));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(bots.create({ ...social, id: bot.id }))));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            projects.create({
              commandId: CommandId.make("command:deleted-bot"),
              projectId: ProjectId.make("project:deleted-bot"),
              title: "Deleted",
              workspaceRoot: "/work/deleted",
              botId: bot.id,
            }),
          ),
        ),
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(bots.delete(CAPTAIN_BOT_ID))));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(bots.moveProject({ projectId: owned.id, botId: "bot:missing" })),
        ),
      );
    }),
  );

  it.effect("moves projects to a bot it creates once, however many moves ask at once", () =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const projects = yield* ProjectService.ProjectService;
      const project = (id: string) =>
        projects.create({
          commandId: CommandId.make(`command:${id}`),
          projectId: ProjectId.make(id),
          title: id,
          workspaceRoot: `/work/${id}`,
        });
      const drafts = [yield* project("project:draft-a"), yield* project("project:draft-b")];
      // The bot's ID where it came from is taken here by a namesake renamed since.
      yield* bots.create({ ...social, id: "bot:writer", name: "Not the writer" });
      const writer = { name: "Writer", avatar: social.avatar, color: social.color };

      const moved = yield* Effect.forEach(
        drafts,
        (draft) =>
          bots.moveProject({ projectId: draft.id, botId: "bot:writer", ensureBot: writer }),
        { concurrency: "unbounded" },
      );
      const writers = (yield* bots.list).filter((bot) => bot.name === "Writer");
      assert.lengthOf(writers, 1);
      assert.notStrictEqual(writers[0]!.id, "bot:writer");
      assert.deepStrictEqual(
        moved.map((each) => each.botId),
        [writers[0]!.id, writers[0]!.id],
      );

      // Captain is never created: every environment has it, whatever it's called there.
      const toCaptain = yield* bots.moveProject({
        projectId: drafts[0]!.id,
        botId: CAPTAIN_BOT_ID,
        ensureBot: { ...writer, name: "Skipper" },
      });
      assert.strictEqual(toCaptain.botId, CAPTAIN_BOT_ID);
      assert.isFalse((yield* bots.list).some((bot) => bot.name === "Skipper"));
    }),
  );

  it.effect("deleting a bot deletes the automations that run as it, and only those", () =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
      const bot = yield* bots.create({ ...social, id: "bot:automations" });
      const asBot = (yield* scheduledTasks.upsert(automation("Weekly post", bot.id))).task;
      const asCaptain = (yield* scheduledTasks.upsert(automation("Captain's", CAPTAIN_BOT_ID)))
        .task;
      const plain = (yield* scheduledTasks.upsert(automation("Plain", null))).task;
      assert.strictEqual(asBot.botId, bot.id);

      yield* bots.delete(bot.id);
      assert.deepStrictEqual(
        (yield* scheduledTasks.list()).tasks.map((task) => task.id).toSorted(),
        [asCaptain.id, plain.id].toSorted(),
      );
      // A deleted bot can't be given new automations either.
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(scheduledTasks.upsert(automation("Late", bot.id)))),
      );
    }),
  );
});
