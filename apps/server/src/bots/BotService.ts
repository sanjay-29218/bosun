import {
  CAPTAIN_BOT_ID,
  CommandId,
  type Bot,
  type BotAvatar,
  type BotCreateInput,
  type BotMoveProjectInput,
  logicalBotKey,
  type BotUpdateInput,
  type Project,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
     * Refused for Captain and for a bot that still owns a project; move its projects first.
     * Its home stays, for a restore to find. Deletes the automations that run as the bot.
     * Runs the bot already started keep working, but it gets no new ones.
     */
    readonly delete: (id: string) => Effect.Effect<void, BotServiceError>;
    /** Sets the rail order; `botIds` lists every bot exactly once. */
    readonly reorder: (
      botIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<Bot>, BotServiceError>;
    /**
     * Gives a project to another bot. With `ensureBot`, that's the bot with the same logical key
     * as `botId`'s, created here once however many moves ask for it at the same time. Such a
     * copy gets its home when it first needs one. Scratch and bots' homes never move.
     */
    readonly moveProject: (
      input: BotMoveProjectInput,
    ) => Effect.Effect<Project, BotServiceError | ProjectService.ProjectServiceError>;
  }
>()("t3/bots/BotService") {}

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

  const createUnlocked = Effect.fn("BotService.insertBot")(function* (input: BotCreateInput) {
    const id = yield* text(input.id, "Bot ID", 128);
    const existing = yield* store.get(id);
    if (existing) {
      if (sameCreate(existing, input)) return existing;
      return yield* new BotValidationError({ reason: "Bot ID belongs to another bot" });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const all = yield* store.list;
    const bot: Bot = {
      id,
      name: yield* text(input.name, "Bot name", 80),
      avatar: input.avatar,
      color: input.color,
      instructions: yield* text(
        input.instructions ?? BOT_DEFAULT_INSTRUCTIONS,
        "Bot instructions",
        16_000,
      ),
      allowedTools: yield* tools(input.allowedTools ?? []),
      runtimeMode: input.runtimeMode ?? "approval-required",
      modelSelection: input.modelSelection ?? null,
      longConversation: input.longConversation ?? "compact",
      position: all.reduce((max, other) => Math.max(max, other.position + 1), 0),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    if (yield* store.insert(bot)) return bot;
    // A concurrent create with the same ID won, or a crew member already has the ID.
    const winner = yield* store.get(id);
    if (winner && sameCreate(winner, input)) return winner;
    return yield* new BotValidationError({ reason: "Bot ID is already in use" });
  });

  // Creates and find-or-creates run one at a time, so a move never adds a copy of a bot
  // that a racing move or create already made.
  const creating = yield* Semaphore.make(1);

  /** The bot here with `botId`'s logical key, made from `template` when there's none. */
  const ensureBot = (botId: string, template: NonNullable<BotMoveProjectInput["ensureBot"]>) =>
    creating.withPermits(1)(
      Effect.gen(function* () {
        const key = logicalBotKey({ id: botId, name: template.name });
        if (key === logicalBotKey({ id: CAPTAIN_BOT_ID, name: "" })) return CAPTAIN_BOT_ID;
        const here = (yield* store.list).find((bot) => logicalBotKey(bot) === key);
        if (here) return here.id;
        const made = yield* createUnlocked({
          id: `bot-${yield* random.uuidV4()}`,
          name: template.name,
          avatar: template.avatar,
          color: template.color,
          ...(template.modelSelection === undefined
            ? {}
            : { modelSelection: template.modelSelection }),
        });
        return made.id;
      }),
    );

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
        ...(input.allowedTools === undefined
          ? {}
          : { allowedTools: yield* tools(input.allowedTools) }),
        ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        ...(input.longConversation === undefined
          ? {}
          : { longConversation: input.longConversation }),
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
      if (id === CAPTAIN_BOT_ID) {
        return yield* new BotValidationError({ reason: "Captain can't be deleted" });
      }
      const deletedAt = DateTime.formatIso(yield* DateTime.now);
      const home = yield* folders.botHomePath(id);
      const result = yield* store.withOwnership(
        store.deleteUnlessOwning(id, deletedAt, Option.getOrNull(home)),
      );
      if (result === "owns-projects") {
        return yield* new BotValidationError({
          reason: "Move this bot's projects to another bot before deleting it",
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
      const botId =
        input.ensureBot === undefined
          ? (yield* requireBot(input.botId)).id
          : yield* ensureBot(input.botId, input.ensureBot);
      const commandId = CommandId.make(`bot-move:${yield* random.uuidV4()}`);
      return yield* projects.assignBot({ commandId, projectId, botId });
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
  });
});

export const layer = Layer.effect(BotService, make);
