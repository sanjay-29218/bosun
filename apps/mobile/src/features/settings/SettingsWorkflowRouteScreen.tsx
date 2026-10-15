import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { AppText as Text } from "../../components/AppText";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SettingsScreen } from "./components/SettingsScreen";
import { MobileBotsProjectSection } from "./MobileBotsProjectSection";
import { MobileFeaturesProjectSection } from "./MobileFeaturesProjectSection";
import { MobileWorkflowProjectSection } from "./MobileWorkflowProjectSection";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export function SettingsWorkflowRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const group = projectGroups.find((entry) => entry.key === selectedProjectKey);
  const selectedEnvironmentIds = new Set(selectedTargets.map((entry) => entry.environmentId));
  const members =
    group?.members
      .map((entry) => entry.project)
      .filter((project) => selectedEnvironmentIds.has(project.environmentId)) ?? [];
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Workflow" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {members.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              Choose a project and connected environment in the filter above to track features,
              configure its crew, and run workflows.
            </Text>
          ) : (
            <WorkflowContent
              key={`${selectedProjectKey}:${members.map((member) => member.id).join(",")}`}
              members={members}
              environments={selectedTargets}
            />
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function WorkflowContent(props: {
  readonly members: readonly EnvironmentProject[];
  readonly environments: readonly SettingsTarget[];
}) {
  const [featureSelections, setFeatureSelections] = useState<Record<string, string>>({});
  return (
    <>
      {props.members.map((member) => {
        const environment = props.environments.find(
          (entry) => entry.environmentId === member.environmentId,
        );
        const capabilities = environment?.serverConfig.environment.capabilities;
        return !capabilities?.features && !capabilities?.bots && !capabilities?.workflows ? (
          <Text
            key={`unsupported:${member.environmentId}:${member.id}`}
            className="px-2 text-base text-foreground-muted"
          >
            {environment?.label ?? "This environment"} does not currently support workflows. Connect
            or update its server to continue.
          </Text>
        ) : null;
      })}
      {props.members.map((member) => {
        const environment = props.environments.find(
          (entry) => entry.environmentId === member.environmentId,
        );
        return environment?.serverConfig.environment.capabilities.features === true ? (
          <MobileFeaturesProjectSection
            key={`features:${member.environmentId}:${member.id}`}
            project={member}
            environmentLabel={environment.label}
            onSelect={(id) =>
              setFeatureSelections((current) => ({
                ...current,
                [`${member.environmentId}:${member.id}`]: id,
              }))
            }
          />
        ) : null;
      })}
      {props.members.map((member) => {
        const environment = props.environments.find(
          (entry) => entry.environmentId === member.environmentId,
        );
        return environment?.serverConfig.environment.capabilities.bots === true ? (
          <MobileBotsProjectSection
            key={`bots:${member.environmentId}:${member.id}`}
            project={member}
            environmentLabel={environment.label}
          />
        ) : null;
      })}
      {props.members.map((member) => {
        const environment = props.environments.find(
          (entry) => entry.environmentId === member.environmentId,
        );
        return environment?.serverConfig.environment.capabilities.workflows === true ? (
          <MobileWorkflowProjectSection
            key={`workflows:${member.environmentId}:${member.id}:${featureSelections[`${member.environmentId}:${member.id}`] ?? "manual"}`}
            initialFeatureId={featureSelections[`${member.environmentId}:${member.id}`]}
            project={member}
            environmentLabel={environment.label}
          />
        ) : null;
      })}
    </>
  );
}
