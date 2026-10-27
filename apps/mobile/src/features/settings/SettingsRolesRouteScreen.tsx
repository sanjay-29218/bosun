import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../state/entities";
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
                <EnvironmentRolesPanel target={target} />
              </SettingsSection>
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

/** The environment's roles, starting new roles and the starter set on its default model. */
function EnvironmentRolesPanel({ target }: { readonly target: SettingsTarget }) {
  const config = useEnvironmentServerConfig(target.environmentId);
  const defaultSelection = resolveDefaultableModelSelection(
    config,
    target.serverConfig.settings.defaultModelSelection,
    null,
  );
  const modelSelection = resolveNewTaskModelSelection({
    draftSelection: null,
    projectDefaultSelection: defaultSelection,
    stickySelection: null,
    modelOptions: buildModelOptions(config, defaultSelection, undefined, null),
  });
  return <MobileRolesPanel environmentId={target.environmentId} modelSelection={modelSelection} />;
}
