import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { MobileRolesPanel } from "./MobileRoleConfigurationPanel";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

/** Each environment's roles. A project's crew members are set up in its project settings. */
export function SettingsRolesRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  const targets = selectedTargets.filter(
    (target) => target.serverConfig.environment.capabilities.crew === true,
  );
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Roles" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {targets.length === 0 ? (
            <Text className="text-foreground-muted">
              Select a connected environment that runs a crew.
            </Text>
          ) : (
            targets.map((target) => (
              <SettingsSection key={target.environmentId} title={target.label}>
                <MobileRolesPanel
                  environmentId={target.environmentId}
                  modelSelection={environmentModelSelection(target)}
                />
              </SettingsSection>
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

/** The environment's default model, which new roles and the starter set begin with. */
function environmentModelSelection(target: SettingsTarget) {
  const config = target.serverConfig;
  const defaultSelection = resolveDefaultableModelSelection(
    config,
    config.settings.defaultModelSelection,
  );
  return resolveNewTaskModelSelection({
    draftSelection: null,
    projectDefaultSelection: defaultSelection,
    stickySelection: null,
    modelOptions: buildModelOptions(config, defaultSelection),
  });
}
