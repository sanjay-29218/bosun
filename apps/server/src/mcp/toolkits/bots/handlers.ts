import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BotService from "../../../bots/BotService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BotsToolkit } from "./tools.ts";

const failed = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/** Bots and project ownership belong to the environment, so changing them needs full access. */
export const layer = McpToolAccess.toLayer(BotsToolkit, {
  t3_bot_list: McpToolAccess.reads(() =>
    BotService.BotService.pipe(
      Effect.flatMap((bots) => bots.list),
      Effect.map((bots) => ({ bots })),
      Effect.mapError(failed),
    ),
  ),
  t3_bot_create: McpToolAccess.writesEnvironment((input) =>
    BotService.BotService.pipe(
      Effect.flatMap((bots) => bots.create(input)),
      Effect.mapError(failed),
    ),
  ),
  t3_bot_update: McpToolAccess.writesEnvironment((input) =>
    BotService.BotService.pipe(
      Effect.flatMap((bots) => bots.update(input)),
      Effect.mapError(failed),
    ),
  ),
  t3_bot_delete: McpToolAccess.writesEnvironment((input) =>
    BotService.BotService.pipe(
      Effect.flatMap((bots) => bots.delete(input.id)),
      Effect.as({ deleted: true }),
      Effect.mapError(failed),
    ),
  ),
  t3_bot_reorder: McpToolAccess.writesEnvironment((input) =>
    BotService.BotService.pipe(
      Effect.flatMap((bots) => bots.reorder(input.botIds)),
      Effect.map((bots) => ({ bots })),
      Effect.mapError(failed),
    ),
  ),
  t3_bot_move_project: McpToolAccess.writesEnvironment((input) =>
    BotService.BotService.pipe(
      Effect.flatMap((bots) => bots.moveProject(input)),
      Effect.mapError(failed),
    ),
  ),
});
