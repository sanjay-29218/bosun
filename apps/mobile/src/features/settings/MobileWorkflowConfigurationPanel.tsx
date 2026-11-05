import {
  FEATURE_DELIVERY_WORKFLOW_ID,
  FEATURE_MANAGER_ROLE_ID,
  type EnvironmentId,
  type RoleConfig,
  type WorkflowConfig,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { Action, useRun } from "./MobileRoleConfigurationPanel";

interface WorkflowFields {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly leadRoleId: string;
  readonly crewRoleIds: Array<string>;
  readonly expectedRevision?: number;
}

function Editor(props: {
  readonly workflow: WorkflowConfig | null;
  readonly roles: ReadonlyArray<RoleConfig>;
  readonly busy: boolean;
  readonly onSave: (value: WorkflowFields) => Promise<boolean>;
  readonly onDelete: (workflow: WorkflowConfig) => void;
}) {
  const [name, setName] = useState(props.workflow?.name ?? "");
  const [instructions, setInstructions] = useState(props.workflow?.instructions ?? "");
  const [leadRoleId, setLeadRoleId] = useState(
    props.workflow?.leadRoleId ??
      (props.roles.some((role) => role.id === FEATURE_MANAGER_ROLE_ID)
        ? FEATURE_MANAGER_ROLE_ID
        : ""),
  );
  const [crewRoleIds, setCrewRoleIds] = useState<ReadonlyArray<string>>(
    props.workflow?.crewRoleIds ?? [],
  );
  // The fields above match this revision; a newer save elsewhere refuses this one.
  const [baseRevision, setBaseRevision] = useState(props.workflow?.revision);
  const canSave = !!name.trim() && !!instructions.trim() && !!leadRoleId;
  const roleName = (id: string) => props.roles.find((role) => role.id === id)?.name ?? id;
  // Roles that are off or gone stay listed while the workflow names them, so they can be removed.
  const crewChoices = [
    ...props.roles.filter((role) => role.enabled).map((role) => role.id),
    ...crewRoleIds.filter((id) => !props.roles.some((role) => role.enabled && role.id === id)),
  ].filter((id) => id !== leadRoleId);

  return (
    <View className="gap-2 rounded-xl border border-border-subtle p-3">
      <Text className="text-sm font-t3-medium text-foreground">
        {props.workflow?.name ?? "New workflow"}
      </Text>
      <AppTextInput
        accessibilityLabel="Workflow name"
        placeholder="Name"
        value={name}
        onChangeText={setName}
        maxLength={200}
      />
      <Text className="text-xs text-foreground-muted">Lead</Text>
      <View className="flex-row flex-wrap gap-1.5">
        {props.roles
          .filter((role) => role.enabled || role.id === leadRoleId)
          .map((role) => (
            <Action
              key={role.id}
              label={role.name}
              selected={leadRoleId === role.id}
              onPress={() => setLeadRoleId(role.id)}
            />
          ))}
      </View>
      <Text className="text-xs text-foreground-muted">Crew the lead can hand work to</Text>
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
        accessibilityLabel="Workflow instructions"
        placeholder="Instructions for the lead"
        value={instructions}
        onChangeText={setInstructions}
        maxLength={16000}
        multiline
        textAlignVertical="top"
        className="min-h-28"
      />
      <View className="flex-row flex-wrap gap-2">
        <Action
          label="Save workflow"
          disabled={!canSave || props.busy}
          onPress={() => {
            void props
              .onSave({
                id: props.workflow?.id ?? `workflow:${uuidv4()}`,
                name: name.trim(),
                instructions: instructions.trim(),
                leadRoleId,
                crewRoleIds: crewRoleIds.filter((id) => id !== leadRoleId),
                ...(baseRevision !== undefined ? { expectedRevision: baseRevision } : {}),
              })
              .then((saved) => {
                if (saved && baseRevision !== undefined) setBaseRevision(baseRevision + 1);
              });
          }}
        />
        {props.workflow && props.workflow.id !== FEATURE_DELIVERY_WORKFLOW_ID ? (
          <Action
            label="Delete workflow"
            disabled={props.busy}
            onPress={() => props.onDelete(props.workflow!)}
          />
        ) : null}
      </View>
    </View>
  );
}

/** An environment's workflows: which role leads a feature, its crew, and the lead's instructions. */
export function MobileWorkflowsPanel(props: { readonly environmentId: EnvironmentId }) {
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
        A feature follows one workflow. Its lead gets the instructions, the crew and the brief.
      </Text>
      {workflowsQuery.error || rolesQuery.error ? (
        <Text className="text-sm text-red-500">{workflowsQuery.error ?? rolesQuery.error}</Text>
      ) : null}
      {error ? <Text className="text-sm text-red-500">{error}</Text> : null}
      <View className="flex-row flex-wrap gap-2">
        <Action
          label="New workflow"
          selected={workflowId === null}
          onPress={() => setWorkflowId(null)}
        />
        {workflows.map((item) => (
          <Action
            key={item.id}
            label={item.name}
            selected={workflowId === item.id}
            onPress={() => setWorkflowId(item.id)}
          />
        ))}
      </View>
      <Editor
        key={`${workflow?.id ?? "new"}:${rolesQuery.isSuccess}`}
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
            title: "Delete workflow",
            message: `Delete ${target.name}? New features can no longer follow it.`,
            confirmText: "Delete",
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
