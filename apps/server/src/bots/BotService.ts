import {
  CommandId,
  type Bot,
  type BotAvatar,
  type BotCreateInput,
  type BotMoveProjectInput,
  type BotSetPinInput,
  type BotUpdateInput,
  LEGACY_TOOLS_MESSAGE,
  type Project,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { crewChangeNotifier } from "../crew/CrewChanges.ts";
import { CrewService } from "../crew/CrewService.ts";
import { BOT_DEFAULT_INSTRUCTIONS } from "../crew/crewPrompts.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as BotStore from "./BotStore.ts";
import {
  type BotHomeFile,
  readHomeFiles,
  tooLargeMessage,
  writeHomeFiles,
} from "./botHomeFiles.ts";

export class BotValidationError extends Schema.TaggedError<BotValidationError>()(
  "BotValidationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export type BotServiceError = BotValidationError | PersistenceSqlError;

export class BotService extends Context.Service<
  BotService,
  {
    /** Every bot in rail order, each with its `homePath`. */
    readonly list: Effect.Effect<ReadonlyArray<Bot>, BotServiceError>;
    readonly get: (id: string) => Effect.Effect<Bot | null, BotServiceError>;
    /**
     * Adds a bot at the end of the rail, with its home. Repeating the same create returns the
     * same bot.
     */
    readonly create: (input: BotCreateInput) => Effect.Effect<Bot, BotServiceError>;
    readonly update: (input: BotUpdateInput) => Effect.Effect<Bot, BotServiceError>;
    /**
     * Refused while the bot owns a project; give its projects to another bot or to none first.
     * Its home stays, for a restore to find. Deletes the automations that run as the bot.
     * Runs the bot already started keep working, but it gets no new ones.
     */
    readonly delete: (id: string) => Effect.Effect<void, BotServiceError>;
    /** Sets the rail order; `botIds` lists every bot exactly once. */
    readonly reorder: (
      botIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<Bot>, BotServiceError>;
    /**
     * Gives a project to another bot, or to none when `botId` is null. With `remoteBot`, to that
     * bot on another environment, which works on it over the link. Scratch and bots' homes never
     * move.
     */
    readonly moveProject: (
      input: BotMoveProjectInput,
    ) => Effect.Effect<Project, BotServiceError | ProjectService.ProjectServiceError>;
    /** Pins a bot or a project's manager to the main rail, or unpins it. */
    readonly setPin: (
      input: BotSetPinInput,
    ) => Effect.Effect<void, BotServiceError | ProjectService.ProjectServiceError>;
    /** The files in the bot's home folder, refused when too many or too large to send. */
    readonly homeFiles: (id: string) => Effect.Effect<ReadonlyArray<BotHomeFile>, BotServiceError>;
    /**
     * Adds a bot sent from another machine, as it was there, at the end of the rail, with its
     * home folder's files. Repeating the same copy returns the same bot.
     */
    readonly insertCopy: (input: {
      readonly bot: BotCopy;
      readonly homeFiles: ReadonlyArray<BotHomeFile>;
    }) => Effect.Effect<Bot, BotServiceError>;
    /**
     * Removes the bot and everything of it here: its automations, its home with its
     * headquarters, and its home folder. Refused while it owns a project other than its home.
     * `forgetId` frees the ID too, for a copy undone before anyone used it.
     */
    readonly removeCompletely: (
      id: string,
      options?: { readonly forgetId?: boolean },
    ) => Effect.Effect<void, BotServiceError>;
  }
>()("t3/bots/BotService") {}

/** A bot's definition as another machine sends it, under the ID it gets here. */
export type BotCopy = Pick<
  Bot,
  | "id"
  | "name"
  | "avatar"
  | "color"
  | "instructions"
  | "withheldTools"
  | "runtimeMode"
  | "modelSelection"
  | "longConversation"
  | "permittedEnvironmentIds"
>;

const text = (value: string, field: string, max: number) => {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max
    ? Effect.succeed(trimmed)
    : Effect.fail(new BotValidationError({ reason: `${field} must contain 1-${max} characters` }));
};
const tools = (value: ReadonlyArray<string>) =>
  value.length <= 32 && value.every((tool) => tool.trim().length > 0 && tool.length <= 100)
    ? Effect.succeed([...new Set(value.map((tool) => tool.trim()))])
    : Effect.fail(new BotValidationError({ reason: "Invalid tool grants" }));

const sameAvatar = (left: BotAvatar, right: BotAvatar) =>
  left.head === right.head &&
  left.eyes === right.eyes &&
  left.face === right.face &&
  left.top === right.top &&
  left.cheeks === right.cheeks &&
  left.smile === right.smile;

/** An older client's `allowedTools` meant the opposite, so it is refused rather than read. */
const refuseLegacyTools = (input: { readonly allowedTools?: unknown }) =>
  input.allowedTools === undefined
    ? Effect.void
    : Effect.fail(new BotValidationError({ reason: LEGACY_TOOLS_MESSAGE }));

const sameCreate = (bot: Bot, input: BotCreateInput) =>
  bot.name === input.name.trim() &&
  sameAvatar(bot.avatar, input.avatar) &&
  bot.color === input.color;

const make = Effect.gen(function* () {
  const store = yield* BotStore.BotStore;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Optional so bot tests run without the crew; the server always provides it.
  const crew = yield* Effect.serviceOption(CrewService);

  const requireBot = (id: string) =>
    store
      .get(id)
      .pipe(
        Effect.filterOrFail(
          Predicate.isNotNull,
          () => new BotValidationError({ reason: "Bot not found" }),
        ),
      );

  /** The bot's home project, when the bot has one. */
  const homeProject = Effect.fn("BotService.homeProject")(function* (botId: string) {
    const root = yield* folders.botHomePath(botId);
    if (Option.isNone(root)) return Option.none<Project>();
    return yield* projects
      .getByWorkspaceRoot(root.value)
      .pipe(Effect.orElseSucceed(() => Option.none<Project>()));
  });

  const withHome = Effect.fn("BotService.withHome")(function* (bot: Bot) {
    const home = yield* homeProject(bot.id);
    return { ...bot, homePath: Option.isSome(home) ? home.value.workspaceRoot : null };
  });

  const ensureHome = (bot: Bot) =>
    folders
      .ensureBotHome(bot)
      .pipe(Effect.mapError((error) => new BotValidationError({ reason: error.message })));

  /** Inserts `bot` at the end of the rail, or returns the bot already under its ID if `same`. */
  const insertUnlocked = Effect.fn("BotService.insertBot")(function* (
    bot: Omit<Bot, "position" | "pinned" | "revision" | "createdAt" | "updatedAt">,
    same: (existing: Bot) => boolean,
  ) {
    const existing = yield* store.get(bot.id);
    if (existing) {
      if (same(existing)) return existing;
      return yield* new BotValidationError({ reason: "Bot ID belongs to another bot" });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const all = yield* store.list;
    const inserted: Bot = {
      ...bot,
      position: all.reduce((max, other) => Math.max(max, other.position + 1), 0),
      pinned: true,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    if (yield* store.insert(inserted)) return inserted;
    // A concurrent create with the same ID won, or a crew member already has the ID.
    const winner = yield* store.get(bot.id);
    if (winner && same(winner)) return winner;
    return yield* new BotValidationError({ reason: "Bot ID is already in use" });
  });

  const createUnlocked = Effect.fn("BotService.createBot")(function* (input: BotCreateInput) {
    yield* refuseLegacyTools(input);
    return yield* insertUnlocked(
      {
        id: yield* text(input.id, "Bot ID", 128),
        name: yield* text(input.name, "Bot name", 80),
        avatar: input.avatar,
        color: input.color,
        instructions: yield* text(
          input.instructions ?? BOT_DEFAULT_INSTRUCTIONS,
          "Bot instructions",
          16_000,
        ),
        withheldTools: yield* tools(input.withheldTools ?? []),
        runtimeMode: input.runtimeMode ?? "full-access",
        modelSelection: input.modelSelection ?? null,
        longConversation: input.longConversation ?? "compact",
        permittedEnvironmentIds: yield* store.linkedEnvironmentIds,
      },
      (existing) => sameCreate(existing, input),
    );
  });

  // Creates run one at a time, so each reads the rail position the one before it wrote.
  const creating = yield* Semaphore.make(1);

  const service = BotService.of({
    list: store.list.pipe(Effect.flatMap(Effect.forEach(withHome))),
    get: Effect.fn("BotService.get")(function* (id) {
      const bot = yield* store.get(id);
      return bot === null ? null : yield* withHome(bot);
    }),
    create: Effect.fn("BotService.create")(function* (input) {
      const bot = yield* creating.withPermits(1)(createUnlocked(input));
      const home = yield* ensureHome(bot);
      return { ...bot, homePath: home.workspaceRoot };
    }),
    update: Effect.fn("BotService.update")(function* (input) {
      yield* refuseLegacyTools(input);
      const previous = yield* requireBot(input.id);
      if (previous.revision !== input.expectedRevision) {
        return yield* new BotValidationError({ reason: "Bot changed; reload and retry" });
      }
      const next: Bot = {
        ...previous,
        ...(input.name === undefined ? {} : { name: yield* text(input.name, "Bot name", 80) }),
        ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.instructions === undefined
          ? {}
          : { instructions: yield* text(input.instructions, "Bot instructions", 16_000) }),
        ...(input.withheldTools === undefined
          ? {}
          : { withheldTools: yield* tools(input.withheldTools) }),
        ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        ...(input.longConversation === undefined
          ? {}
          : { longConversation: input.longConversation }),
        ...(input.permittedEnvironmentIds === undefined
          ? {}
          : { permittedEnvironmentIds: [...new Set(input.permittedEnvironmentIds)] }),
        revision: previous.revision + 1,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      if (!(yield* store.update(next, previous.revision))) {
        return yield* new BotValidationError({ reason: "Bot changed; reload and retry" });
      }
      const home = yield* homeProject(next.id);
      if (next.name !== previous.name && Option.isSome(home)) {
        yield* projects
          .update({
            commandId: CommandId.make(`bot-home-title:${next.id}:${next.revision}`),
            projectId: home.value.id,
            title: next.name,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Bot home retitle failed", { botId: next.id, error }),
            ),
          );
      }
      // An open headquarters takes the new runtime mode and model on its next turn.
      if (Option.isSome(crew)) {
        yield* crew.value
          .syncHeadquarters(next.id)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Headquarters settings sync failed", { botId: next.id, error }),
            ),
          );
      }
      return { ...next, homePath: Option.isSome(home) ? home.value.workspaceRoot : null };
    }),
    delete: Effect.fn("BotService.delete")(function* (id) {
      const deletedAt = DateTime.formatIso(yield* DateTime.now);
      const home = yield* folders.botHomePath(id);
      const result = yield* store.withOwnership(
        store.deleteUnlessOwning(id, deletedAt, Option.getOrNull(home)),
      );
      if (result === "owns-projects") {
        return yield* new BotValidationError({
          reason: "Unlink this bot's projects before deleting it",
        });
      }
      if (result === "missing") {
        return yield* new BotValidationError({ reason: "Bot not found" });
      }
      // Saving a bot task checks the bot in the same write, so none can land after this.
      yield* scheduledTasks.deleteForBot(id).pipe(
        Effect.mapError(
          () =>
            new BotValidationError({
              reason: "Deleted the bot, but not its automations; delete them in Automations",
            }),
        ),
      );
    }),
    reorder: Effect.fn("BotService.reorder")(function* (botIds) {
      const all = yield* store.list;
      const ids = new Set(botIds);
      if (
        ids.size !== botIds.length ||
        ids.size !== all.length ||
        all.some((bot) => !ids.has(bot.id))
      ) {
        return yield* new BotValidationError({
          reason: "Reorder must list every bot exactly once",
        });
      }
      yield* store.setPositions(botIds, DateTime.formatIso(yield* DateTime.now));
      return yield* store.list;
    }),
    moveProject: Effect.fn("BotService.moveProject")(function* (input) {
      const { projectId } = input;
      if (yield* folders.isHiddenProject(projectId)) {
        return yield* new BotValidationError({ reason: "Scratch and bots' homes can't move" });
      }
      const commandId = CommandId.make(`bot-move:${yield* random.uuidV4()}`);
      const { remoteBot } = input;
      if (remoteBot !== undefined) {
        return yield* projects.assignBot({ commandId, projectId, botId: null, remoteBot });
      }
      const botId = input.botId === null ? null : (yield* requireBot(input.botId)).id;
      return yield* projects.assignBot({ commandId, projectId, botId });
    }),
    setPin: Effect.fn("BotService.setPin")(function* (input) {
      const { botId, projectId } = input;
      if ((botId === undefined) === (projectId === undefined)) {
        return yield* new BotValidationError({ reason: "Name exactly one of botId and projectId" });
      }
      if (projectId === undefined) {
        if (botId === undefined || !(yield* store.setPinned(botId, input.pinned))) {
          return yield* new BotValidationError({ reason: "Bot not found" });
        }
        return;
      }
      if (yield* folders.isHiddenProject(projectId)) {
        return yield* new BotValidationError({
          reason: "Scratch and bots' homes have no project manager",
        });
      }
      yield* projects.setManagerPinned({
        commandId: CommandId.make(`manager-pin:${yield* random.uuidV4()}`),
        projectId,
        pinned: input.pinned,
      });
    }),
    homeFiles: Effect.fn("BotService.homeFiles")(function* (id) {
      const bot = yield* requireBot(id);
      const root = yield* folders.botHomePath(id);
      if (Option.isNone(root)) return [];
      const read = yield* readHomeFiles(root.value).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (error) =>
            new BotValidationError({
              reason: `Couldn't read ${bot.name}'s home folder: ${error.message}`,
            }),
        ),
      );
      if (read._tag === "too-large") {
        return yield* new BotValidationError({ reason: tooLargeMessage(bot.name, read) });
      }
      return read.files;
    }),
    insertCopy: Effect.fn("BotService.insertCopy")(function* ({ bot: sent, homeFiles }) {
      const bot = yield* creating.withPermits(1)(
        insertUnlocked(
          {
            id: yield* text(sent.id, "Bot ID", 128),
            name: yield* text(sent.name, "Bot name", 80),
            avatar: sent.avatar,
            color: sent.color,
            instructions: yield* text(sent.instructions, "Bot instructions", 16_000),
            withheldTools: yield* tools(sent.withheldTools),
            runtimeMode: sent.runtimeMode,
            modelSelection: sent.modelSelection,
            longConversation: sent.longConversation,
            permittedEnvironmentIds: [...new Set(sent.permittedEnvironmentIds)],
          },
          (existing) => existing.name === sent.name.trim(),
        ),
      );
      const home = yield* ensureHome(bot);
      yield* writeHomeFiles(home.workspaceRoot, homeFiles).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (error) =>
            new BotValidationError({
              reason: `Couldn't write ${bot.name}'s home folder: ${typeof error === "string" ? error : error.message}`,
            }),
        ),
      );
      return { ...bot, homePath: home.workspaceRoot };
    }),
    removeCompletely: Effect.fn("BotService.removeCompletely")(function* (id, options) {
      const root = yield* folders.botHomePath(id);
      const home = yield* homeProject(id);
      // Gone first, so nothing new starts as it; a retry after a later step failed goes on.
      const result = yield* store.withOwnership(
        store.deleteUnlessOwning(
          id,
          DateTime.formatIso(yield* DateTime.now),
          Option.match(home, {
            onNone: () => Option.getOrNull(root),
            onSome: (project) => project.workspaceRoot,
          }),
        ),
      );
      if (result === "owns-projects") {
        return yield* new BotValidationError({
          reason: "Give this bot's projects to another bot or to none first",
        });
      }
      const failed = (what: string) => (error: { readonly message: string }) =>
        new BotValidationError({ reason: `Couldn't remove its ${what}: ${error.message}` });
      yield* scheduledTasks.deleteForBot(id).pipe(Effect.mapError(failed("automations")));
      if (Option.isSome(home)) {
        // Its headquarters goes with it: the bot is gone, so that thread is never needed again.
        yield* projects
          .delete({
            commandId: CommandId.make(`bot-remove:${id}:${home.value.id}`),
            projectId: home.value.id,
            force: true,
          })
          .pipe(Effect.mapError(failed("home")));
      }
      if (Option.isSome(root)) {
        yield* fileSystem
          .remove(root.value, { recursive: true, force: true })
          .pipe(Effect.mapError(failed("home folder")));
      }
      if (options?.forgetId === true) yield* store.purge(id);
    }),
  });
  // Every change tells clients to re-read the bots, whoever asked for it.
  const bots = (yield* crewChangeNotifier).notifying("bots");
  return BotService.of({
    ...service,
    create: bots(service.create),
    update: bots(service.update),
    delete: bots(service.delete),
    reorder: bots(service.reorder),
    moveProject: bots(service.moveProject),
    setPin: bots(service.setPin),
    insertCopy: bots(service.insertCopy),
    removeCompletely: bots(service.removeCompletely),
  });
});

export const layer = Layer.effect(BotService, make);
