import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BotService from "../../../bots/BotService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { asWorkflowManager, fullAccessCaller } from "../workflows/access.ts";
import { BotsToolkit } from "./tools.ts";

const failed = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/**
 * Bots and project ownership belong to the environment: a bot changes them with "Manage
 * workflows", and every other caller needs full access.
 */
const checkChange = asWorkflowManager(
  fullAccessCaller(
    "Changing bots needs a live full-access/default calling thread or a full-access client.",
  ),
);

const changingBots = <A, E extends { readonly message: string }>(
  change: (bots: BotService.BotService["Service"]) => Effect.Effect<A, E>,
) =>
  checkChange.pipe(
    Effect.andThen(BotService.BotService),
    Effect.flatMap((bots) => change(bots).pipe(Effect.mapError(failed))),
  );

export const layer = McpToolAccess.toLayer(BotsToolkit, {
  t3_bot_list: McpToolAccess.reads(() =>
    BotService.BotService.pipe(
      Effect.flatMap((bots) => bots.list),
      Effect.map((bots) => ({ bots })),
      Effect.mapError(failed),
    ),
  ),
  t3_bot_create: McpToolAccess.writesWithCapability((input) =>
    changingBots((bots) => bots.create(input)),
  ),
  t3_bot_update: McpToolAccess.writesWithCapability((input) =>
    changingBots((bots) => bots.update(input)),
  ),
  t3_bot_delete: McpToolAccess.writesWithCapability((input) =>
    changingBots((bots) => bots.delete(input.id)).pipe(Effect.as({ deleted: true })),
  ),
  t3_bot_reorder: McpToolAccess.writesWithCapability((input) =>
    changingBots((bots) => bots.reorder(input.botIds)).pipe(Effect.map((bots) => ({ bots }))),
  ),
  t3_bot_move_project: McpToolAccess.writesWithCapability((input) =>
    changingBots((bots) => bots.moveProject(input)),
  ),
});
