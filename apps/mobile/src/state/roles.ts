import { createRoleAtoms } from "@t3tools/client-runtime/state/roles";

import { connectionAtomRuntime } from "../connection/runtime";

export const rolesEnvironment = createRoleAtoms(connectionAtomRuntime);
