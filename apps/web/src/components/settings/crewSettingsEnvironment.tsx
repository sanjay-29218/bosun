import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";

import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";

type CrewCapability = keyof Pick<ExecutionEnvironmentCapabilities, "bots" | "crew" | "workflows">;

/**
 * The environment the Bots, Workflows and Roles pages edit. They are environment-local, so the
 * settings layout pins the scope to one environment for them, like Providers.
 */
export function useCrewSettingsEnvironment(capability: CrewCapability) {
  const { environment } = useSettingsScope();
  return {
    environment,
    supported: environment?.serverConfig?.environment.capabilities[capability] === true,
  };
}

/** Why the page can't edit its environment, or nothing when it can. */
export function CrewEnvironmentNotice({
  connected,
  supported,
  noun,
}: {
  readonly connected: boolean;
  readonly supported: boolean;
  readonly noun: string;
}) {
  if (!connected)
    return (
      <SettingsRow
        title="No environment connected"
        description={`Connect an environment to edit its ${noun}.`}
      />
    );
  if (!supported)
    return (
      <SettingsRow
        title="Unavailable on this environment"
        description={`Update this environment to edit its ${noun}.`}
      />
    );
  return null;
}
