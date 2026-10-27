import { workflowStageOverview, workflowSummaryLine } from "@t3tools/client-runtime/crew-stage";
import type { EnvironmentId, WorkflowDefinition } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { workflowsEnvironment } from "../../state/workflows";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

/**
 * Each environment's workflow library, read-only. Tap a workflow to see its stages; editing
 * stays on web and desktop.
 */
export function SettingsWorkflowsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  const targets = selectedTargets.filter(
    (target) => target.serverConfig.environment.capabilities.workflows === true,
  );
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Workflows" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {targets.length === 0 ? (
            <Text className="text-foreground-muted">
              Select a connected environment that runs workflows.
            </Text>
          ) : (
            targets.map((target) => (
              <SettingsSection key={target.environmentId} title={target.label}>
                <EnvironmentWorkflows environmentId={target.environmentId} />
              </SettingsSection>
            ))
          )}
          <Text className="px-1 text-sm text-foreground-muted">
            Workflows are edited in T3 Code on web or desktop.
          </Text>
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentWorkflows(props: { readonly environmentId: EnvironmentId }) {
  const definitions = useEnvironmentQuery(
    workflowsEnvironment.definitions({ environmentId: props.environmentId, input: {} }),
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (definitions.error) {
    return <Text className="p-4 text-sm text-red-500">{definitions.error}</Text>;
  }
  if (definitions.data === null) {
    return <Text className="p-4 text-sm text-foreground-muted">Loading workflows…</Text>;
  }
  if (definitions.data.length === 0) {
    return <Text className="p-4 text-sm text-foreground-muted">No workflows yet.</Text>;
  }
  return (
    <View>
      {definitions.data.map((definition, index) => (
        <WorkflowRow
          key={definition.id}
          definition={definition}
          first={index === 0}
          expanded={expandedId === definition.id}
          onToggle={() =>
            setExpandedId((current) => (current === definition.id ? null : definition.id))
          }
        />
      ))}
    </View>
  );
}

function WorkflowRow(props: {
  readonly definition: WorkflowDefinition;
  readonly first: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const { definition } = props;
  const stages = workflowStageOverview(definition);
  return (
    <View className={props.first ? undefined : "border-t border-border-subtle"}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        onPress={props.onToggle}
        className="gap-0.5 p-4 active:opacity-70"
      >
        <Text className="text-base font-t3-medium text-foreground">
          {definition.name} {props.expanded ? "▾" : "▸"}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {`v${definition.revision} · ${stages.length} ${stages.length === 1 ? "stage" : "stages"}`}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={props.expanded ? 0 : 1}>
          {workflowSummaryLine(definition)}
        </Text>
      </Pressable>
      {props.expanded ? (
        <View className="gap-3 px-4 pb-4">
          {stages.map((stage, index) => (
            <View key={stage.stepId} className="gap-0.5">
              <Text className="text-sm font-t3-medium text-foreground">
                {`${index + 1}. ${stage.name}`}
                {stage.gate ? " · needs approval" : ""}
              </Text>
              <Text className="text-xs text-foreground-muted">{stage.role}</Text>
              {stage.routes.map((route) => (
                <Text key={route} className="text-xs text-foreground-muted">
                  {route}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
