import { T, useGT } from "gt-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { MobileWorkflowsPanel } from "./MobileWorkflowConfigurationPanel";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

/** Each environment's workflows, beside its roles. */
export function SettingsWorkflowsRouteScreen() {
  const gt = useGT();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  const environmentMenu = useSettingsEnvironmentMenu();
  const targets = selectedTargets.filter(
    (target) => target.serverConfig.environment.capabilities.crew === true,
  );
  return (
    <>
      <SettingsScreen title={gt("Workflows")} menus={[environmentMenu]}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {targets.length === 0 ? (
            <Text className="text-foreground-muted">
              <T>Select a connected environment that runs a crew.</T>
            </Text>
          ) : (
            targets.map((target) => (
              <SettingsSection key={target.environmentId} title={target.label}>
                <MobileWorkflowsPanel environmentId={target.environmentId} />
              </SettingsSection>
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}
