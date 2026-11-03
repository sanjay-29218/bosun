import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { crewThreadGrants } from "../../../crew/crewMcpCapabilities.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { assertFullAccess, readCaller } from "../../threadAccess.ts";

/** "Manage bots, roles and workflows" unlocks the Library, bot and feature tools for a bot's threads. */
const MANAGE_CREW = "crew.workflows";

const manageCrewDenied = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "This bot can't manage bots, roles or workflows. A person can allow it with \"Manage bots, roles and workflows\" in the bot's Tools settings.",
});

/** The calling bot or crew thread's grants; undefined for every other caller. */
const callerGrants = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.thread === undefined ? Effect.undefined : crewThreadGrants(scope.thread.threadId),
  ),
);

/** Crew threads need "Manage bots, roles and workflows"; others pass `others` instead. */
export const asCrewManager = Effect.fn("FeaturesToolkit.asCrewManager")(function* <E, R>(
  others: Effect.Effect<unknown, E, R>,
) {
  const grants = yield* callerGrants;
  if (grants === undefined) yield* others;
  else if (!grants.includes(MANAGE_CREW)) return yield* manageCrewDenied;
});

/** What a caller that isn't a crew thread needs to change the environment's shared setup. */
export const fullAccessCaller = (message: string) =>
  readCaller().pipe(Effect.flatMap((caller) => assertFullAccess(caller, message)));
