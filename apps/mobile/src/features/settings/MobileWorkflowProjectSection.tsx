import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { workflowsEnvironment } from "../../state/workflows";
import { SettingsSection } from "./components/SettingsSection";

/**
 * The project's workflows, read-only. Editing workflows and the crew stays on web and
 * desktop; running features is done from the Features screen and each stage thread.
 */
export function MobileWorkflowProjectSection(props: {
  readonly project: EnvironmentProject;
  readonly environmentLabel: string;
}) {
  const { project } = props;
  const definitions = useEnvironmentQuery(
    workflowsEnvironment.definitions({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );

  return (
    <SettingsSection title={`Workflows · ${props.environmentLabel}`}>
      <View className="gap-3 p-4">
        {definitions.error ? (
          <Text className="text-sm text-red-500">{definitions.error}</Text>
        ) : null}
        {definitions.data?.map((definition) => (
          <Text key={definition.id} className="text-sm text-foreground">
            {definition.name} · version {definition.revision}
          </Text>
        ))}
        <Text className="text-sm text-foreground-muted">
          {definitions.data?.length === 0 ? "No workflows yet. " : ""}
          Workflows and the crew are edited in T3 Code on web or desktop.
        </Text>
      </View>
    </SettingsSection>
  );
}
