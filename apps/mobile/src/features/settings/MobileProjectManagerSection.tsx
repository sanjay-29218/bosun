import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  CREW_TOOL_GRANTS,
  ProviderInstanceId,
  type ModelSelection,
  type ProjectManagerSettings,
  type RuntimeMode,
} from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Alert, View } from "react-native";
import * as Cause from "effect/Cause";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { Action, useRun } from "./MobileRoleConfigurationPanel";

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/** The project's manager: its standing thread and the settings it runs with here. */
export function MobileProjectManagerSection(props: {
  readonly project: EnvironmentProject;
  readonly environmentLabel: string;
}) {
  const { project } = props;
  const query = useEnvironmentQuery(
    rolesEnvironment.projectManager({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  return (
    <SettingsSection title={`Project manager · ${props.environmentLabel}`}>
      {query.data === null ? (
        <Text className="p-4 text-sm text-foreground-muted">{query.error ?? "Loading…"}</Text>
      ) : (
        // A new revision, from a save, a reset or a role edit, starts the form over from it.
        <Form
          key={query.data.revision}
          project={project}
          settings={query.data}
          onStale={query.refresh}
        />
      )}
    </SettingsSection>
  );
}

function Form(props: {
  readonly project: EnvironmentProject;
  readonly settings: ProjectManagerSettings;
  readonly onStale: () => void;
}) {
  const { project, settings } = props;
  const navigation = useNavigation();
  const update = useAtomCommand(rolesEnvironment.updateProjectManager, { reportFailure: false });
  const reset = useAtomCommand(rolesEnvironment.resetProjectManager, { reportFailure: false });
  const open = useAtomCommand(rolesEnvironment.openProjectManager, { reportFailure: false });
  const canEdit = useAtomValue(
    rolesEnvironment.updateProjectManager.permissionAtom(project.environmentId),
  );
  // When someone else saved first, the refresh brings their revision in place of this form.
  const { busy, error, run } = useRun(() => undefined);
  const [instructions, setInstructions] = useState(settings.instructions);
  const [tools, setTools] = useState<ReadonlyArray<string>>(settings.allowedTools);
  const [instanceId, setInstanceId] = useState<string>(settings.modelSelection.instanceId);
  const [model, setModel] = useState(settings.modelSelection.model);
  const [runtimeMode, setRuntimeMode] = useState(settings.runtimeMode);
  const [longConversation, setLongConversation] = useState(settings.longConversation);
  const target = { environmentId: project.environmentId };
  const modelSelection: ModelSelection =
    instanceId.trim() === settings.modelSelection.instanceId &&
    model.trim() === settings.modelSelection.model
      ? settings.modelSelection
      : { instanceId: ProviderInstanceId.make(instanceId.trim()), model: model.trim() };
  const canSave =
    canEdit && !busy && !!instructions.trim() && !!instanceId.trim() && !!model.trim();

  const save = () =>
    run(async () => {
      const result = await update({
        ...target,
        input: {
          projectId: project.id,
          instructions: instructions.trim(),
          allowedTools: [...tools],
          modelSelection,
          runtimeMode,
          longConversation,
          expectedRevision: settings.revision,
        },
      });
      if (result._tag !== "Success") props.onStale();
      return result;
    });

  const resetToRole = () =>
    Alert.alert("Reset to role defaults?", "Its settings here are replaced by the role's.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reset",
        style: "destructive",
        onPress: () =>
          void run(async () => {
            const result = await reset({
              ...target,
              input: { projectId: project.id, expectedRevision: settings.revision },
            });
            if (result._tag !== "Success") props.onStale();
            return result;
          }),
      },
    ]);

  const openThread = async () => {
    const result = await open({ ...target, input: { projectId: project.id } });
    if (result._tag === "Success") {
      navigation.dispatch(
        StackActions.push("Thread", {
          environmentId: String(project.environmentId),
          threadId: String(result.value.threadId),
        }),
      );
    } else {
      Alert.alert("Could not open the project manager", Cause.pretty(result.cause));
    }
  };

  return (
    <View className="gap-2 p-4">
      <Text className="text-xs text-foreground-muted">
        {settings.customized
          ? "Customized for this project. Edits to the Project manager role don't reach it until you reset it."
          : "Follows the Project manager role until you save changes here."}
      </Text>
      <AppTextInput
        accessibilityLabel="Project manager instructions"
        placeholder="Instructions"
        value={instructions}
        onChangeText={setInstructions}
        maxLength={16000}
        multiline
        textAlignVertical="top"
        className="min-h-28"
        editable={canEdit && !busy}
      />
      <AppTextInput
        accessibilityLabel="Project manager provider instance"
        placeholder="Provider instance"
        value={instanceId}
        onChangeText={setInstanceId}
        editable={canEdit && !busy}
      />
      <AppTextInput
        accessibilityLabel="Project manager model"
        placeholder="Model"
        value={model}
        onChangeText={setModel}
        editable={canEdit && !busy}
      />
      <Text className="text-xs text-foreground-muted">
        Tools. T3 Code tools are all on unless you pick some to limit it to.
      </Text>
      <View className="flex-row flex-wrap gap-1.5">
        {[
          ...CREW_TOOL_GRANTS.filter((grant) => !("botOnly" in grant)),
          ...tools
            .filter((id) => !CREW_TOOL_GRANTS.some((grant) => grant.id === id))
            .map((id) => ({ id, label: id })),
        ].map((grant) => {
          const selected = tools.includes(grant.id);
          return (
            <Action
              key={grant.id}
              label={grant.label}
              selected={selected}
              disabled={!canEdit}
              onPress={() =>
                setTools(selected ? tools.filter((id) => id !== grant.id) : [...tools, grant.id])
              }
            />
          );
        })}
      </View>
      <View className="flex-row flex-wrap gap-1.5">
        <Action
          label={`T3 runtime: ${runtimeMode}`}
          disabled={!canEdit}
          onPress={() =>
            setRuntimeMode(
              RUNTIME_MODES[(RUNTIME_MODES.indexOf(runtimeMode) + 1) % RUNTIME_MODES.length]!,
            )
          }
        />
        <Action
          label={
            longConversation === "new-session"
              ? "Long conversations: new session"
              : "Long conversations: compact"
          }
          disabled={!canEdit}
          onPress={() =>
            setLongConversation(longConversation === "new-session" ? "compact" : "new-session")
          }
        />
      </View>
      <View className="flex-row flex-wrap gap-1.5">
        <Action label="Save" disabled={!canSave} onPress={() => void save()} />
        {settings.customized ? (
          <Action
            label="Reset to role defaults"
            disabled={!canEdit || busy}
            onPress={resetToRole}
          />
        ) : null}
        <Action label="Open project manager" onPress={() => void openThread()} />
      </View>
      {error ? <Text className="text-sm text-red-500">{error}</Text> : null}
    </View>
  );
}
