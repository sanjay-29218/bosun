import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectIconColor, ProjectRemoteBot } from "./project.ts";

/**
 * Every bot has one headquarters: a crew run in the bot's home, created when first needed.
 * It sees all the bot's projects and leads their features, so clients can find its thread by id.
 */
export const BOT_HEADQUARTERS_RUN_PREFIX = "bot-hq:";
export const botHeadquartersRunId = (botId: string) => `${BOT_HEADQUARTERS_RUN_PREFIX}${botId}`;
export const botHeadquartersThreadId = (botId: string) =>
  ThreadId.make(`bot-run:${botHeadquartersRunId(botId)}`);
/** The bot whose headquarters `threadId` is, or null for every other thread. */
export const headquartersBotId = (threadId: string): string | null =>
  threadId.startsWith(`bot-run:${BOT_HEADQUARTERS_RUN_PREFIX}`)
    ? threadId.slice(`bot-run:${BOT_HEADQUARTERS_RUN_PREFIX}`.length)
    : null;

/** A project's standing manager: one run and thread per project, made on first use. */
export const PROJECT_HEADQUARTERS_RUN_PREFIX = "project-hq:";
export const projectHeadquartersRunId = (projectId: string) =>
  `${PROJECT_HEADQUARTERS_RUN_PREFIX}${projectId}`;
export const projectHeadquartersThreadId = (projectId: string) =>
  ThreadId.make(`bot-run:${projectHeadquartersRunId(projectId)}`);
/** The project whose manager `threadId` is, or null for every other thread. */
export const headquartersProjectId = (threadId: string): ProjectId | null =>
  threadId.startsWith(`bot-run:${PROJECT_HEADQUARTERS_RUN_PREFIX}`)
    ? ProjectId.make(threadId.slice(`bot-run:${PROJECT_HEADQUARTERS_RUN_PREFIX}`.length))
    : null;
/** A thread that lives as long as its owner: a bot's headquarters or a project's manager. */
export const isStandingThread = (threadId: string) =>
  headquartersBotId(threadId) !== null || headquartersProjectId(threadId) !== null;
/** A bot's avatar: a small robot built from these parts and tinted with the bot's color. */
export const BOT_HEADS = [
  "squircle",
  "round",
  "wide",
  "tall",
  "dome",
  "cat",
  "peak",
  "gem",
] as const;
/**
 * What the eyes sit on: a dark visor, a light face plate, or the head itself. `flat` is the
 * bare head drawn in one flat color, without shine or shadow.
 */
export const BOT_FACES = ["visor", "plate", "bare", "flat"] as const;
const BOT_EYES = [
  "round",
  "happy",
  "wink",
  "sleepy",
  "star",
  "tall",
  "visor",
  "heart",
  "big",
  "dash",
] as const;
const BOT_TOPS = [
  "ball",
  "double",
  "ears",
  "sprout",
  "propeller",
  "headphones",
  "bow",
  "halo",
  "horns",
  "none",
] as const;
export const BotAvatar = Schema.Struct({
  head: Schema.Literals(BOT_HEADS),
  face: Schema.Literals(BOT_FACES),
  eyes: Schema.Literals(BOT_EYES),
  top: Schema.Literals(BOT_TOPS),
  cheeks: Schema.Boolean,
  smile: Schema.Boolean,
});
export type BotAvatar = typeof BotAvatar.Type;

/** Labels the briefing that opens a headquarters' new session, so clients mark where it began. */
export const BOT_FRESH_START_LABEL = "Fresh start";
const isFreshStartRecord = Schema.is(
  Schema.Struct({ kind: Schema.Literal("bot"), label: Schema.Literal(BOT_FRESH_START_LABEL) }),
);
export const isBotFreshStartContext = (
  context: { readonly records: ReadonlyArray<unknown> } | undefined,
): boolean => context?.records.some(isFreshStartRecord) ?? false;

/** Older linked servers omit keys added since; a missing list decodes as empty. */
const listDefaultingToEmpty = <S extends Schema.Top>(item: S) =>
  Schema.Array(item).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])));

/**
 * A bot's move to another machine that hasn't finished. `pending` until the target confirms it
 * took the copy: the move can still be undone there. `confirmed` after: the copy runs there, and
 * only removing the bot here is left.
 */
export const BotPendingMove = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  newBotId: Schema.String,
  state: Schema.Literals(["pending", "confirmed"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("pending" as const)),
  ),
});
export type BotPendingMove = typeof BotPendingMove.Type;

export const Bot = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  avatar: BotAvatar,
  color: ProjectIconColor,
  instructions: Schema.String,
  /** The model its runs use; null until one is chosen (`crew.initialize` fills it in). */
  modelSelection: Schema.NullOr(ModelSelection),
  /**
   * Every environment linked to its home, the one that stores it. A bot works on each of them;
   * the global link list is the only control. Read-only, worked out when listed.
   */
  linkedEnvironmentIds: listDefaultingToEmpty(EnvironmentId),
  /** Rail order, counted from 0. */
  position: Schema.Int,
  /** Shown in the main rail; every bot is listed under Bots either way. Absent: pinned. */
  pinned: Schema.optional(Schema.Boolean),
  revision: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /**
   * The bot's own folder on its environment, where its headquarters works. Null until the
   * home exists: a bot gets one when it is created, or first opens or schedules work.
   */
  homePath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** A move to another machine that hasn't finished; null or absent when none. */
  movingTo: Schema.optionalKey(Schema.NullOr(BotPendingMove)),
});
export type Bot = typeof Bot.Type;

/** `id` is chosen by the caller, so a retry with the same input returns the same bot. */
export const BotCreateInput = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  avatar: BotAvatar,
  color: ProjectIconColor,
  instructions: Schema.optionalKey(Schema.String),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
});
export type BotCreateInput = typeof BotCreateInput.Type;

/** Changes the given fields; `expectedRevision` rejects an edit made from a stale copy. */
export const BotUpdateInput = Schema.Struct({
  id: Schema.String,
  expectedRevision: Schema.Int,
  name: Schema.optionalKey(Schema.String),
  avatar: Schema.optionalKey(BotAvatar),
  color: Schema.optionalKey(ProjectIconColor),
  instructions: Schema.optionalKey(Schema.String),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
});
export type BotUpdateInput = typeof BotUpdateInput.Type;

/** Refused while the bot owns a project; give its projects to another bot or to none first. */
export const BotDeleteInput = Schema.Struct({ id: Schema.String });
/** The whole rail order: every bot exactly once. */
export const BotReorderInput = Schema.Struct({ botIds: Schema.Array(Schema.String) });
/**
 * Gives a project to `botId`, or to no bot when it is null. With `remoteBot`, the project goes to
 * that bot on another environment instead, and `botId` repeats its id, so an older server that
 * doesn't know `remoteBot` refuses the move rather than clearing the owner.
 */
export const BotMoveProjectInput = Schema.Struct({
  projectId: ProjectId,
  botId: Schema.NullOr(Schema.String),
  remoteBot: Schema.optionalKey(ProjectRemoteBot),
});
export type BotMoveProjectInput = typeof BotMoveProjectInput.Type;

/** Pins a bot, or a project's manager, to the main rail, or unpins it. Names exactly one. */
export const BotSetPinInput = Schema.Struct({
  botId: Schema.optionalKey(Schema.String),
  projectId: Schema.optionalKey(ProjectId),
  pinned: Schema.Boolean,
});
export type BotSetPinInput = typeof BotSetPinInput.Type;

export const BotTransferMode = Schema.Literals(["copy", "move"]);
export type BotTransferMode = typeof BotTransferMode.Type;

/**
 * Copies a bot to a linked machine, or moves it there. `newBotId` is chosen once per attempt, so
 * a retry finishes or undoes the same transfer. `dryRun` changes nothing and returns the preview.
 */
export const BotTransferInput = Schema.Struct({
  botId: Schema.String,
  targetEnvironmentId: EnvironmentId,
  newBotId: Schema.String,
  mode: BotTransferMode,
  dryRun: Schema.optionalKey(Schema.Boolean),
  /**
   * Cancels the bot's unfinished move instead, whatever the target says. `undo` needs the target
   * to undo its copy; `forget` stops waiting for it, leaving the automations here off.
   */
  cancelMove: Schema.optionalKey(Schema.Literals(["undo", "forget"])),
});
export type BotTransferInput = typeof BotTransferInput.Type;

/**
 * What becomes of one of the bot's projects: it comes along on a move, stays with the original on
 * a copy, or is left with no bot when the target has no link to its machine.
 */
export const BotTransferProjectOutcome = Schema.Literals([
  "comes-along",
  "stays-with-original",
  "left-without-bot",
]);
export type BotTransferProjectOutcome = typeof BotTransferProjectOutcome.Type;

export const BotTransferResult = Schema.Struct({
  /** The bot on the target machine. */
  bot: Schema.Struct({ environmentId: EnvironmentId, id: Schema.String, name: Schema.String }),
  projects: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      environmentLabel: Schema.String,
      projectId: ProjectId,
      title: Schema.String,
      outcome: BotTransferProjectOutcome,
    }),
  ),
  /** Linked machines that didn't answer, so their projects may still name the bot. */
  unchecked: Schema.Array(Schema.Struct({ environmentId: EnvironmentId, label: Schema.String })),
  automations: Schema.Struct({
    copied: Schema.Int,
    /** How many were on; a move keeps them on, a copy brings every one turned off. */
    enabled: Schema.Int,
    needAttention: Schema.Array(Schema.Struct({ title: Schema.String, reason: Schema.String })),
  }),
  warnings: Schema.Array(Schema.String),
});
export type BotTransferResult = typeof BotTransferResult.Type;

export class BotOperationError extends Schema.TaggedError<BotOperationError>()(
  "BotOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
