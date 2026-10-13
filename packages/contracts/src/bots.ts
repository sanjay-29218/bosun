import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectIconColor } from "./project.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/**
 * Top-level bots (Captain, Social, Finance...) own projects; each project has exactly one.
 * Bots are environment-local. Captain always exists and owns projects created without a bot.
 */
export const CAPTAIN_BOT_ID = "bot-captain";

export const Bot = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The bot's avatar. */
  emoji: Schema.String,
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
  emoji: Schema.String,
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
  emoji: Schema.optionalKey(Schema.String),
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
