import { createFeatureThreadAtoms } from "@t3tools/client-runtime/state/featureThreads";

import { connectionAtomRuntime } from "../connection/runtime";

export const featureThreadsEnvironment = createFeatureThreadAtoms(connectionAtomRuntime);
