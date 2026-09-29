import {
  ProviderInstanceId,
  type BotTemplateConfig,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { botsEnvironment } from "../../state/bots";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

function Action(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled, selected: props.selected }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`rounded-full px-3 py-2 active:opacity-70 disabled:opacity-40 ${props.selected ? "bg-subtle-strong" : "bg-card"}`}
    >
      <Text className="text-sm text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function Editor(props: {
  readonly template: BotTemplateConfig | null;
  readonly modelSelection: ModelSelection | null;
  readonly busy: boolean;
  readonly onSave: (value: {
    readonly id: string;
    readonly name: string;
    readonly instructions: string;
    readonly allowedTools: Array<string>;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly autoCreateForFeature: boolean;
    readonly enabled: boolean;
    readonly expectedRevision?: number;
  }) => void;
}) {
  const initialModel = props.template?.modelSelection ?? props.modelSelection;
  const [name, setName] = useState(props.template?.name ?? "");
  const [instructions, setInstructions] = useState(props.template?.instructions ?? "");
  const [allowedTools, setAllowedTools] = useState(props.template?.allowedTools.join(", ") ?? "");
  const [instanceId, setInstanceId] = useState(initialModel?.instanceId ?? "");
  const [model, setModel] = useState(initialModel?.model ?? "");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    props.template?.runtimeMode ?? "approval-required",
  );
  const [autoCreateForFeature, setAutoCreateForFeature] = useState(
    props.template?.autoCreateForFeature ?? false,
  );
  const [enabled, setEnabled] = useState(props.template?.enabled ?? true);
  const readOnly = props.template?.projectId === null;
  const canSave = !!name.trim() && !!instructions.trim() && !!instanceId.trim() && !!model.trim();

  return (
    <View className="gap-2 rounded-xl border border-border-subtle p-3">
      <Text className="text-sm font-t3-medium text-foreground">
        {props.template?.name ?? "New template"}
      </Text>
      {readOnly ? (
        <Text className="text-xs text-foreground-muted">Environment template</Text>
      ) : null}
      <AppTextInput
        accessibilityLabel="Bot template name"
        placeholder="Name"
        value={name}
        onChangeText={setName}
        maxLength={200}
        editable={!readOnly}
      />
      <AppTextInput
        accessibilityLabel="Bot template instructions"
        placeholder="Instructions"
        value={instructions}
        onChangeText={setInstructions}
        maxLength={16000}
        editable={!readOnly}
        multiline
        textAlignVertical="top"
        className="min-h-28"
      />
      <AppTextInput
        accessibilityLabel="Bot provider instance"
        placeholder="Provider instance"
        value={instanceId}
        onChangeText={setInstanceId}
        editable={!readOnly}
      />
      <AppTextInput
        accessibilityLabel="Bot model"
        placeholder="Model"
        value={model}
        onChangeText={setModel}
        editable={!readOnly}
      />
      <AppTextInput
        accessibilityLabel="Allowed bot tools"
        placeholder="Allowed bot tools, separated by commas"
        value={allowedTools}
        onChangeText={setAllowedTools}
        editable={!readOnly}
      />
      <Action
        label={`T3 runtime: ${runtimeMode}`}
        disabled={readOnly}
        onPress={() =>
          setRuntimeMode(
            RUNTIME_MODES[(RUNTIME_MODES.indexOf(runtimeMode) + 1) % RUNTIME_MODES.length]!,
          )
        }
      />
      <Action
        label={`Feature default: ${autoCreateForFeature ? "on" : "off"}`}
        disabled={readOnly}
        onPress={() => setAutoCreateForFeature(!autoCreateForFeature)}
      />
      {props.template ? (
        <Action
          label={`Enabled: ${enabled ? "on" : "off"}`}
          disabled={readOnly}
          onPress={() => setEnabled(!enabled)}
        />
      ) : null}
      {!readOnly ? (
        <Action
          label="Save template"
          disabled={!canSave || props.busy}
          onPress={() => {
            const modelSelection: ModelSelection = {
              instanceId: ProviderInstanceId.make(instanceId.trim()),
              model: model.trim(),
              ...(props.template?.modelSelection.instanceId === instanceId.trim() &&
              props.template.modelSelection.model === model.trim() &&
              props.template.modelSelection.options
                ? { options: props.template.modelSelection.options }
                : {}),
            };
            props.onSave({
              id: props.template?.id ?? `bot-template:${uuidv4()}`,
              name: name.trim(),
              instructions: instructions.trim(),
              allowedTools: [
                ...new Set(
                  allowedTools
                    .split(",")
                    .map((tool) => tool.trim())
                    .filter(Boolean),
                ),
              ],
              modelSelection,
              runtimeMode,
              autoCreateForFeature,
              enabled,
              ...(props.template ? { expectedRevision: props.template.revision } : {}),
            });
          }}
        />
      ) : null}
    </View>
  );
}

export function MobileBotConfigurationPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection | null;
  readonly bots: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly projectId: ProjectId | null;
  }>;
}) {
  const { environmentId, projectId } = props;
  const configuration = useEnvironmentQuery(
    botsEnvironment.configuration({ environmentId, input: { projectId } }),
  );
  const initialize = useAtomCommand(botsEnvironment.initialize);
  const createTemplate = useAtomCommand(botsEnvironment.createTemplate);
  const updateTemplate = useAtomCommand(botsEnvironment.updateTemplate);
  const instantiate = useAtomCommand(botsEnvironment.instantiate);
  const setHierarchy = useAtomCommand(botsEnvironment.setHierarchy);
  const setDelegation = useAtomCommand(botsEnvironment.setDelegation);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [botId, setBotId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templates = configuration.data?.templates ?? [];
  const needsStarter = !templates.some(
    (template) => template.id === `template:manager:${projectId}`,
  );
  const template = templates.find((item) => item.id === templateId) ?? null;
  const nodes = configuration.data?.hierarchy ?? [];
  const grants = configuration.data?.delegationGrants ?? [];
  const selectedBot = props.bots.find((bot) => bot.id === botId);
  const parentId = nodes.find((node) => node.botId === botId)?.parentBotId ?? null;
  const granted = grants.some(
    (grant) => grant.sourceBotId === botId && grant.targetBotId === targetId,
  );
  const run = async (
    action: () => Promise<{ readonly _tag: string; readonly cause?: unknown }>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result._tag !== "Success") setError(Cause.pretty(result.cause as Cause.Cause<unknown>));
      else configuration.refresh();
      return result._tag === "Success";
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="gap-3 border-t border-border-subtle pt-4">
      <Text className="text-sm font-t3-medium text-foreground">Templates and permissions</Text>
      <Text className="text-xs text-foreground-muted">
        Template edits affect future bots. Hierarchy and delegation are separate settings.
      </Text>
      {needsStarter ? (
        <Action
          label="Add starter bots"
          disabled={busy || !props.modelSelection}
          onPress={() => {
            if (props.modelSelection)
              void run(() =>
                initialize({
                  environmentId,
                  input: { projectId, modelSelection: props.modelSelection! },
                }),
              );
          }}
        />
      ) : null}
      {configuration.error ? (
        <Text className="text-sm text-red-500">{configuration.error}</Text>
      ) : null}
      {error ? <Text className="text-sm text-red-500">{error}</Text> : null}
      <View className="flex-row flex-wrap gap-2">
        <Action
          label="New template"
          selected={templateId === null}
          onPress={() => setTemplateId(null)}
        />
        {templates.map((item) => (
          <Action
            key={item.id}
            label={item.name}
            selected={templateId === item.id}
            onPress={() => setTemplateId(item.id)}
          />
        ))}
      </View>
      <Editor
        key={template?.id ?? "new"}
        template={template}
        modelSelection={props.modelSelection}
        busy={busy}
        onSave={(value) => {
          const input = { ...value, projectId };
          if (value.expectedRevision !== undefined) {
            void run(() =>
              updateTemplate({
                environmentId,
                input: { ...input, expectedRevision: value.expectedRevision! },
              }),
            );
          } else {
            void run(() => createTemplate({ environmentId, input })).then((saved) => {
              if (saved) setTemplateId(value.id);
            });
          }
        }}
      />
      {template?.enabled ? (
        <Action
          label="Add bot from template"
          disabled={busy}
          onPress={() =>
            void run(() =>
              instantiate({
                environmentId,
                input: { id: `bot:${uuidv4()}`, projectId, templateId: template.id },
              }),
            )
          }
        />
      ) : null}
      {props.bots.length > 0 ? (
        <View className="gap-2 border-t border-border-subtle pt-3">
          <Text className="text-sm font-t3-medium text-foreground">Hierarchy</Text>
          <Text className="text-xs text-foreground-muted">
            Choose a bot, then its parent. Peers share a parent.
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {props.bots.map((bot) => (
              <Action
                key={bot.id}
                label={bot.name}
                selected={botId === bot.id}
                onPress={() => {
                  setBotId(bot.id);
                  setTargetId(null);
                }}
              />
            ))}
          </View>
          {selectedBot?.projectId === projectId ? (
            <View className="flex-row flex-wrap gap-2">
              <Action
                label="Root"
                selected={parentId === null}
                disabled={busy}
                onPress={() =>
                  void run(() =>
                    setHierarchy({
                      environmentId,
                      input: { projectId, botId: selectedBot.id, parentBotId: null, position: 0 },
                    }),
                  )
                }
              />
              {props.bots
                .filter((bot) => bot.id !== selectedBot.id)
                .map((parent) => (
                  <Action
                    key={parent.id}
                    label={`Under ${parent.name}`}
                    selected={parentId === parent.id}
                    disabled={busy}
                    onPress={() =>
                      void run(() =>
                        setHierarchy({
                          environmentId,
                          input: {
                            projectId,
                            botId: selectedBot.id,
                            parentBotId: parent.id,
                            position: 0,
                          },
                        }),
                      )
                    }
                  />
                ))}
            </View>
          ) : null}
          {selectedBot ? (
            <View className="gap-2 border-t border-border-subtle pt-3">
              <Text className="text-xs text-foreground-muted">
                {selectedBot.name} can delegate to
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {props.bots
                  .filter((bot) => bot.projectId === projectId && bot.id !== selectedBot.id)
                  .map((bot) => (
                    <Action
                      key={bot.id}
                      label={bot.name}
                      selected={targetId === bot.id}
                      onPress={() => setTargetId(bot.id)}
                    />
                  ))}
              </View>
              {targetId ? (
                <Action
                  label={granted ? "Remove delegation" : "Allow delegation"}
                  disabled={busy}
                  onPress={() =>
                    void run(() =>
                      setDelegation({
                        environmentId,
                        input: {
                          projectId,
                          sourceBotId: selectedBot.id,
                          targetBotId: targetId,
                          allowed: !granted,
                        },
                      }),
                    )
                  }
                />
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
