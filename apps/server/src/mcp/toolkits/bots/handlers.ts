import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BotReach from "../../../bots/BotReach.ts";
import * as BotService from "../../../bots/BotService.ts";
import * as BotTransfer from "../../../bots/BotTransfer.ts";
import { LibraryImports } from "../../../crew/LibraryImports.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { fullAccessCaller } from "../features/access.ts";
import { BotsToolkit } from "./tools.ts";

const failed = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/** Bots and project ownership belong to the environment, so changing them needs full access. */
const checkChange = fullAccessCaller(
  "Changing bots needs a live full-access/default calling thread or a full-access client.",
);

const changingBots = <A, E extends { readonly message: string }>(
  change: (bots: BotService.BotService["Service"]) => Effect.Effect<A, E>,
) =>
  checkChange.pipe(
    Effect.andThen(BotService.BotService),
    Effect.flatMap((bots) => change(bots).pipe(Effect.mapError(failed))),
  );

export const layer = McpToolAccess.toLayer(
  BotsToolkit,
  Effect.gen(function* () {
    const reach = yield* BotReach.BotReach;
    const transfer = yield* BotTransfer.BotTransfer;
    const library = yield* LibraryImports;
    return {
      t3_bot_list: McpToolAccess.reads(() => reach.list.pipe(Effect.map((bots) => ({ bots })))),
      t3_bot_create: McpToolAccess.writesWithCapability((input) =>
        Effect.gen(function* () {
          // A bot can't run without a model, and the editor always sets one; a bot an agent
          // creates without one starts on that agent's.
          const modelSelection =
            input.modelSelection ??
            (yield* readCaller().pipe(
              Effect.map(({ caller }) => caller?.modelSelection ?? null),
              Effect.orElseSucceed(() => null),
            ));
          return yield* changingBots((bots) =>
            bots.create(modelSelection === null ? input : { ...input, modelSelection }),
          );
        }),
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
      t3_bot_pin: McpToolAccess.writesWithCapability((input) =>
        changingBots((bots) => bots.setPin(input)).pipe(Effect.as({ pinned: input.pinned })),
      ),
      t3_bot_projects: McpToolAccess.reads((input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => reach.projects(scope, input.botId)),
        ),
      ),
      t3_bot_link_projects: McpToolAccess.reads((input) =>
        reach.projectsForLink(input.home).pipe(Effect.map((projects) => ({ projects }))),
      ),
      t3_bot_link_notices: McpToolAccess.reads((input) =>
        reach.noticesForLink(input.home, input.since).pipe(Effect.map((notices) => ({ notices }))),
      ),
      // The link's own access is checked by the service, which names what to change.
      t3_bot_link_task: McpToolAccess.writes(
        (input) =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.flatMap((scope) => reach.startForLink(scope, input)),
          ),
        { linkedCallers: "allowed" },
      ),
      t3_crew_link_library: McpToolAccess.writes(
        (input) =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.flatMap((scope) => reach.libraryForLink(scope, input)),
          ),
        { linkedCallers: "allowed" },
      ),
      // The service checks the link's access, as for a task.
      t3_crew_link_library_sync: McpToolAccess.writes(
        (input) =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.flatMap((scope) => library.serveSync(scope, input)),
          ),
        { linkedCallers: "allowed" },
      ),
      // As with a task, the service checks the link's access and names what to change.
      t3_bot_link_import: McpToolAccess.writes(
        (input) =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.flatMap((scope) => transfer.importForLink(scope, input)),
          ),
        { linkedCallers: "allowed" },
      ),
      t3_bot_link_rehome: McpToolAccess.writes(
        (input) =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.flatMap((scope) => transfer.rehomeForLink(scope, input)),
          ),
        { linkedCallers: "allowed" },
      ),
    };
  }),
);
