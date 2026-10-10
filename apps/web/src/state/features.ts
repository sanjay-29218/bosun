import { createFeatureAtoms } from "@t3tools/client-runtime/state/features";

import { connectionAtomRuntime } from "../connection/runtime";
import { workflowsEnvironment } from "./workflows";

export const featuresEnvironment = createFeatureAtoms(connectionAtomRuntime, {
  workflowFeature: workflowsEnvironment.feature,
});
