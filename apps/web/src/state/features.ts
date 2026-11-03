import { createFeatureAtoms } from "@t3tools/client-runtime/state/features";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";

export const featuresEnvironment = createFeatureAtoms(connectionAtomRuntime);

/** Whether the environment's server runs features; their entry points hide elsewhere. */
export function useEnvironmentRunsFeatures(environmentId: EnvironmentId | null) {
  const config = useServerConfigs().get(environmentId ?? ("" as EnvironmentId));
  return config?.environment.capabilities.workflows === true;
}
