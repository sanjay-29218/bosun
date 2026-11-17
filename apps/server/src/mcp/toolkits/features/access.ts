import * as Effect from "effect/Effect";

import { assertFullAccess, readCaller } from "../../threadAccess.ts";

/** What a caller needs to change the environment's shared setup, a bot or crew thread included. */
export const fullAccessCaller = (message: string) =>
  readCaller().pipe(Effect.flatMap((caller) => assertFullAccess(caller, message)));
