import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectIconColor } from "./project.ts";
import { RuntimeMode } from "./providerPolicy.ts";

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
/**
 * Which bots across environments are the same bot: the ones with the same name. Bots stay
 * environment-local; this key is how clients merge them in the rail and how one environment
 * finds its bot's counterpart on a linked one.
 */
export const logicalBotKey = (bot: { readonly name: string }): string =>
  `name:${bot.name.trim().toLocaleLowerCase()}`;

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

/**
 * What a bot's headquarters does once its conversation grows long: let the provider compact it,
 * or start a fresh session in the same thread at the next quiet moment.
 */
export const BotLongConversation = Schema.Literals(["compact", "new-session"]);
export type BotLongConversation = typeof BotLongConversation.Type;

/** Labels the briefing that opens a headquarters' new session, so clients mark where it began. */
export const BOT_FRESH_START_LABEL = "Fresh start";
const isFreshStartRecord = Schema.is(
  Schema.Struct({ kind: Schema.Literal("bot"), label: Schema.Literal(BOT_FRESH_START_LABEL) }),
);
export const isBotFreshStartContext = (
  context: { readonly records: ReadonlyArray<unknown> } | undefined,
): boolean => context?.records.some(isFreshStartRecord) ?? false;

/**
 * Builds before #96 sent `allowedTools`, a list with the opposite meaning. Inputs accept the key
 * only so the server can refuse it with a plain message instead of flipping access.
 */
export const LEGACY_ALLOWED_TOOLS = Schema.optionalKey(Schema.Unknown);
export const LEGACY_TOOLS_MESSAGE = "This Bosun is newer; update the app to edit tools.";

export const Bot = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  avatar: BotAvatar,
  color: ProjectIconColor,
  instructions: Schema.String,
  /** The tools a person withheld; every other tool is on. */
  withheldTools: Schema.Array(Schema.String),
  runtimeMode: RuntimeMode,
  /** The model its runs use; null until one is chosen (`crew.initialize` fills it in). */
  modelSelection: Schema.NullOr(ModelSelection),
  longConversation: BotLongConversation,
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
});
export type Bot = typeof Bot.Type;

/** `id` is chosen by the caller, so a retry with the same input returns the same bot. */
export const BotCreateInput = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  avatar: BotAvatar,
  color: ProjectIconColor,
  instructions: Schema.optionalKey(Schema.String),
  withheldTools: Schema.optionalKey(Schema.Array(Schema.String)),
  allowedTools: LEGACY_ALLOWED_TOOLS,
  runtimeMode: Schema.optionalKey(RuntimeMode),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  longConversation: Schema.optionalKey(BotLongConversation),
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
  withheldTools: Schema.optionalKey(Schema.Array(Schema.String)),
  allowedTools: LEGACY_ALLOWED_TOOLS,
  runtimeMode: Schema.optionalKey(RuntimeMode),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  longConversation: Schema.optionalKey(BotLongConversation),
});
export type BotUpdateInput = typeof BotUpdateInput.Type;

/** Refused while the bot owns a project; give its projects to another bot or to none first. */
export const BotDeleteInput = Schema.Struct({ id: Schema.String });
/** The whole rail order: every bot exactly once. */
export const BotReorderInput = Schema.Struct({ botIds: Schema.Array(Schema.String) });
/**
 * Gives a project to `botId`, or to no bot when it is null. With `ensureBot`, `botId` names the
 * bot where it came from instead: the project goes to the bot here with the same name, made from
 * `ensureBot` under a new ID when this environment doesn't have it yet.
 */
export const BotMoveProjectInput = Schema.Struct({
  projectId: ProjectId,
  botId: Schema.NullOr(Schema.String),
  ensureBot: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      avatar: BotAvatar,
      color: ProjectIconColor,
      modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
    }).annotate({
      description:
        "The bot from another environment, made here under a new ID if no bot here has its name.",
    }),
  ),
});
export type BotMoveProjectInput = typeof BotMoveProjectInput.Type;

/** Pins a bot, or a project's manager, to the main rail, or unpins it. Names exactly one. */
export const BotSetPinInput = Schema.Struct({
  botId: Schema.optionalKey(Schema.String),
  projectId: Schema.optionalKey(ProjectId),
  pinned: Schema.Boolean,
});
export type BotSetPinInput = typeof BotSetPinInput.Type;

export class BotOperationError extends Schema.TaggedError<BotOperationError>()(
  "BotOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
