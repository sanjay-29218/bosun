import { createBotsAtoms } from "@t3tools/client-runtime/state/bots";

import { connectionAtomRuntime } from "../connection/runtime";

export const botsEnvironment = createBotsAtoms(connectionAtomRuntime);
