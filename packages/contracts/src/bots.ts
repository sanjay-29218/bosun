import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectIconColor } from "./project.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/**
 * Top-level bots (Captain, Social, Finance...) own projects; each project has exactly one.
 * Bots are environment-local. Captain always exists and owns projects created without a bot.
 */
export const CAPTAIN_BOT_ID = "bot-captain";

/**
 * Every bot has one headquarters: a crew run in the Scratch project, created when first needed.
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

/** A bot's avatar: a small robot built from these parts and tinted with the bot's color. */
export const BOT_HEADS = ["squircle", "round", "wide", "tall", "dome", "cat"] as const;
/** What the eyes sit on: a dark visor, a light face plate, or the head itself. */
export const BOT_FACES = ["visor", "plate", "bare"] as const;
export const BOT_EYES = [
  "round",
  "happy",
  "wink",
  "sleepy",
  "star",
  "tall",
  "visor",
  "heart",
  "big",
] as const;
export const BOT_TOPS = [
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

/** A new bot's tools when its creator doesn't choose any. */
export const DEFAULT_BOT_TOOLS: ReadonlyArray<string> = [
  "crew.delegate",
  "crew.status",
  "crew.answer",
  "crew.projects",
];

export const Bot = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  avatar: BotAvatar,
  color: ProjectIconColor,
  instructions: Schema.String,
  allowedTools: Schema.Array(Schema.String),
  runtimeMode: RuntimeMode,
  /** The model its runs use; null until one is chosen (`crew.initialize` fills it in). */
  modelSelection: Schema.NullOr(ModelSelection),
  /** The workflow clients preselect when a feature starts in one of this bot's projects. */
  defaultWorkflowId: Schema.NullOr(Schema.String),
  /** Rail order, counted from 0. */
  position: Schema.Int,
  revision: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Bot = typeof Bot.Type;

/** `id` is chosen by the caller, so a retry with the same input returns the same bot. */
export const BotCreateInput = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  avatar: BotAvatar,
  color: ProjectIconColor,
  instructions: Schema.optionalKey(Schema.String),
  allowedTools: Schema.optionalKey(Schema.Array(Schema.String)),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultWorkflowId: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
  allowedTools: Schema.optionalKey(Schema.Array(Schema.String)),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultWorkflowId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type BotUpdateInput = typeof BotUpdateInput.Type;

/** Refused while the bot owns a project, and always for Captain. */
export const BotDeleteInput = Schema.Struct({ id: Schema.String });
/** The whole rail order: every bot exactly once. */
export const BotReorderInput = Schema.Struct({ botIds: Schema.Array(Schema.String) });
export const BotMoveProjectInput = Schema.Struct({ projectId: ProjectId, botId: Schema.String });

export class BotOperationError extends Schema.TaggedError<BotOperationError>()(
  "BotOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
