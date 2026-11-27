import {
  FEATURE_DELIVERY_WORKFLOW_ID,
  libraryImportState,
  type EnvironmentId,
  type LibraryPushTarget,
  type RoleConfig,
  type WorkflowConfig,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlsoUpdateOnSheet,
  ImportFromAction,
  MobileImportBanner,
  MobileImportedOn,
  withUpdateDot,
} from "./MobileLibraryImport";
import { Action, useRun } from "./SettingsActions";

interface WorkflowFields {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly crewRoleIds: Array<string>;
  readonly expectedRevision?: number;
  readonly alsoUpdateOn?: ReadonlyArray<LibraryPushTarget>;
}

function Editor(props: {
  readonly environmentId: EnvironmentId;
  readonly onChanged: () => void;
  readonly workflow: WorkflowConfig | null;
  readonly roles: ReadonlyArray<RoleConfig>;
  readonly busy: boolean;
  readonly onSave: (value: WorkflowFields) => Promise<boolean>;
  readonly onDelete: (workflow: WorkflowConfig) => void;
}) {
  const gt = useGT();
  const choices = props.roles;
  const [name, setName] = useState(props.workflow?.name ?? "");
  const [instructions, setInstructions] = useState(props.workflow?.instructions ?? "");
  const [crewRoleIds, setCrewRoleIds] = useState<ReadonlyArray<string>>(
    props.workflow?.crewRoleIds ?? [],
  );
  // The fields above match this revision; a newer save elsewhere refuses this one.
  const [baseRevision, setBaseRevision] = useState(props.workflow?.revision);
  const canSave = !!name.trim() && !!instructions.trim();
  const unsaved =
    props.workflow !== null &&
    (name !== props.workflow.name ||
      instructions !== props.workflow.instructions ||
      crewRoleIds.join("\n") !== props.workflow.crewRoleIds.join("\n"));
  const roleName = (id: string) => props.roles.find((role) => role.id === id)?.name ?? id;
  // Roles that are off or gone stay listed while the workflow names them, so they can be removed.
  const crewChoices = [
    ...choices.filter((role) => role.enabled).map((role) => role.id),
    ...crewRoleIds.filter((id) => !choices.some((role) => role.enabled && role.id === id)),
  ];

  const [asking, setAsking] = useState(false);
  const save = (alsoUpdateOn?: ReadonlyArray<LibraryPushTarget>) => {
    setAsking(false);
    void props
      .onSave({
        id: props.workflow?.id ?? `workflow:${uuidv4()}`,
        name: name.trim(),
        instructions: instructions.trim(),
        crewRoleIds: [...crewRoleIds],
        ...(baseRevision !== undefined ? { expectedRevision: baseRevision } : {}),
        ...(alsoUpdateOn && alsoUpdateOn.length > 0 ? { alsoUpdateOn } : {}),
      })
      .then((saved) => {
        if (saved && baseRevision !== undefined) setBaseRevision(baseRevision + 1);
      });
  };

  return (
    <View className="gap-2 rounded-xl border border-border-subtle p-3">
      <Text className="text-sm font-t3-medium text-foreground">
        {props.workflow?.name ?? gt("New workflow")}
      </Text>
      {props.workflow === null ? null : (
        <MobileImportBanner
          environmentId={props.environmentId}
          kind="workflow"
          item={props.workflow}
          unsaved={unsaved}
          onChanged={props.onChanged}
        />
      )}
      <AppTextInput
        accessibilityLabel={gt("Workflow name")}
        placeholder={gt("Name")}
        value={name}
        onChangeText={setName}
        maxLength={200}
      />
      <Text className="text-xs text-foreground-muted">
        <T>Crew the lead can hand work to</T>
      </Text>
      <View className="flex-row flex-wrap gap-1.5">
        {crewChoices.map((id) => {
          const selected = crewRoleIds.includes(id);
          return (
            <Action
              key={id}
              label={roleName(id)}
              selected={selected}
              onPress={() =>
                setCrewRoleIds(
                  selected ? crewRoleIds.filter((item) => item !== id) : [...crewRoleIds, id],
                )
              }
            />
          );
        })}
      </View>
      <AppTextInput
        accessibilityLabel={gt("Workflow instructions")}
        placeholder={gt("Instructions for the lead")}
        value={instructions}
        onChangeText={setInstructions}
        maxLength={16000}
        multiline
        textAlignVertical="top"
        className="min-h-28"
      />
      <View className="flex-row flex-wrap gap-2">
        <Action
          label={gt("Save workflow")}
          disabled={!canSave || props.busy}
          onPress={() => {
            if (props.workflow && props.workflow.importers.length > 0) setAsking(true);
            else save();
          }}
        />
        {props.workflow && props.workflow.id !== FEATURE_DELIVERY_WORKFLOW_ID ? (
          <Action
            label={gt("Delete workflow")}
            disabled={props.busy}
            onPress={() => props.onDelete(props.workflow!)}
          />
        ) : null}
      </View>
      {props.workflow === null ? null : <MobileImportedOn item={props.workflow} />}
      {asking && props.workflow ? (
        <AlsoUpdateOnSheet
          name={props.workflow.name}
          importers={props.workflow.importers}
          onCancel={() => setAsking(false)}
          onSave={save}
        />
      ) : null}
    </View>
  );
}

/** An environment's workflows: the instructions a feature's lead follows, and its crew. */
export function MobileWorkflowsPanel(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const { environmentId } = props;
  const workflowsQuery = useEnvironmentQuery(
    rolesEnvironment.workflows({ environmentId, input: {} }),
  );
  const rolesQuery = useEnvironmentQuery(rolesEnvironment.roles({ environmentId, input: {} }));
  const create = useAtomCommand(rolesEnvironment.createWorkflow);
  const update = useAtomCommand(rolesEnvironment.updateWorkflow);
  const remove = useAtomCommand(rolesEnvironment.deleteWorkflow);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const { busy, error, run } = useRun(workflowsQuery.refresh);
  const workflows = workflowsQuery.data ?? [];
  const roles = rolesQuery.data ?? [];
  const workflow = workflows.find((item) => item.id === workflowId) ?? null;

  return (
    <View className="gap-3 p-4">
      <Text className="text-xs text-foreground-muted">
        <T>
          A feature follows one workflow. Its lead gets the instructions, the crew and the brief.
        </T>
      </Text>
      {workflowsQuery.error || rolesQuery.error ? (
        <Text className="text-sm text-red-500">{workflowsQuery.error ?? rolesQuery.error}</Text>
      ) : null}
      {error ? <Text className="text-sm text-red-500">{error}</Text> : null}
      <View className="flex-row flex-wrap gap-2">
        <ImportFromAction environmentId={environmentId} />
        <Action
          label={gt("New workflow")}
          selected={workflowId === null}
          onPress={() => setWorkflowId(null)}
        />
        {workflows.map((item) => (
          <Action
            key={item.id}
            label={withUpdateDot(item.name, libraryImportState(item).updateAvailable)}
            selected={workflowId === item.id}
            onPress={() => setWorkflowId(item.id)}
          />
        ))}
      </View>
      <Editor
        key={`${workflow?.id ?? "new"}:${workflow?.revision ?? 0}:${rolesQuery.isSuccess}`}
        environmentId={environmentId}
        onChanged={workflowsQuery.refresh}
        workflow={workflow}
        roles={roles}
        busy={busy}
        onSave={(value) => {
          if (value.expectedRevision !== undefined) {
            return run(() =>
              update({
                environmentId,
                input: { ...value, expectedRevision: value.expectedRevision! },
              }),
            );
          }
          return run(() => create({ environmentId, input: value })).then((saved) => {
            if (saved) setWorkflowId(value.id);
            return saved;
          });
        }}
        onDelete={(target) =>
          Dialog.confirm({
            title: gt("Delete workflow"),
            message: gt("Delete {name}? New features can no longer follow it.", {
              name: target.name,
            }),
            confirmText: gt("Delete", { $context: "verb, confirms deleting a workflow" }),
            destructive: true,
            onConfirm: () =>
              void run(() => remove({ environmentId, input: { id: target.id } })).then(
                (deleted) => {
                  if (deleted) setWorkflowId(null);
                },
              ),
          })
        }
      />
    </View>
  );
}
