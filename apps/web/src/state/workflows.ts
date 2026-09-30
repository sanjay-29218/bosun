import { createWorkflowAtoms } from "@t3tools/client-runtime/state/workflows";

import { connectionAtomRuntime } from "../connection/runtime";

export const workflowsEnvironment = createWorkflowAtoms(connectionAtomRuntime);
