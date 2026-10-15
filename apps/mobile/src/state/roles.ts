import { createRoleAtoms } from "@t3tools/client-runtime/state/roles";

import { connectionAtomRuntime } from "../connection/runtime";
import { workflowsEnvironment } from "./workflows";

export const rolesEnvironment = createRoleAtoms(
  connectionAtomRuntime,
  workflowsEnvironment.libraryChanges,
);
