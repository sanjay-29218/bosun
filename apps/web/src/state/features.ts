import { createFeatureAtoms } from "@t3tools/client-runtime/state/features";
import { connectionAtomRuntime } from "../connection/runtime";

export const featuresEnvironment = createFeatureAtoms(connectionAtomRuntime);
