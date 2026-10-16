import {
  CREW_TOOL_GRANTS,
  PROJECT_MANAGER_ROLE_ID,
  ProviderInstanceId,
  type RoleConfig,
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
import { rolesEnvironment } from "../../state/roles";
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
  readonly role: RoleConfig | null;
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
  }) => Promise<boolean>;
}) {
  const initialModel = props.role?.modelSelection ?? props.modelSelection;
  const [name, setName] = useState(props.role?.name ?? "");
  const [instructions, setInstructions] = useState(props.role?.instructions ?? "");
  const [allowedTools, setAllowedTools] = useState<ReadonlyArray<string>>(
    props.role?.allowedTools ?? [],
  );
  const [instanceId, setInstanceId] = useState(initialModel?.instanceId ?? "");
  const [model, setModel] = useState(initialModel?.model ?? "");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    props.role?.runtimeMode ?? "approval-required",
  );
  const [autoCreateForFeature, setAutoCreateForFeature] = useState(
    props.role?.autoCreateForFeature ?? false,
  );
  const [enabled, setEnabled] = useState(props.role?.enabled ?? true);
  // The fields above match this revision. If someone else saves a newer one, this save is
  // refused instead of overwriting it.
  const [baseRevision, setBaseRevision] = useState(props.role?.revision);
  const canSave = !!name.trim() && !!instructions.trim() && !!instanceId.trim() && !!model.trim();

  return (
    <View className="gap-2 rounded-xl border border-border-subtle p-3">
      <Text className="text-sm font-t3-medium text-foreground">
        {props.role?.name ?? "New role"}
      </Text>
      <AppTextInput
        accessibilityLabel="Role name"
        placeholder="Name"
        value={name}
        onChangeText={setName}
        maxLength={200}
      />
      <AppTextInput
        accessibilityLabel="Role instructions"
        placeholder="Instructions"
        value={instructions}
        onChangeText={setInstructions}
        maxLength={16000}
        multiline
        textAlignVertical="top"
        className="min-h-28"
      />
      <AppTextInput
        accessibilityLabel="Role provider instance"
        placeholder="Provider instance"
        value={instanceId}
        onChangeText={setInstanceId}
      />
      <AppTextInput
        accessibilityLabel="Role model"
        placeholder="Model"
        value={model}
        onChangeText={setModel}
      />
      <Text className="text-xs text-foreground-muted">Tools</Text>
      <View className="flex-row flex-wrap gap-1.5">
        {/* Grants this list doesn't know stay on the role and stay listed so they can be removed. */}
        {[
          ...CREW_TOOL_GRANTS.filter((grant) => !("botOnly" in grant)),
          ...allowedTools
            .filter((id) => !CREW_TOOL_GRANTS.some((grant) => grant.id === id))
            .map((id) => ({ id, label: id })),
        ].map((grant) => {
          const selected = allowedTools.includes(grant.id);
          return (
            <Action
              key={grant.id}
              label={grant.label}
              selected={selected}
              onPress={() =>
                setAllowedTools(
                  selected
                    ? allowedTools.filter((id) => id !== grant.id)
                    : [...allowedTools, grant.id],
                )
              }
            />
          );
        })}
      </View>
      <Action
        label={`T3 runtime: ${runtimeMode}`}
        onPress={() =>
          setRuntimeMode(
            RUNTIME_MODES[(RUNTIME_MODES.indexOf(runtimeMode) + 1) % RUNTIME_MODES.length]!,
          )
        }
      />
      <Action
        label={`Feature default: ${autoCreateForFeature ? "on" : "off"}`}
        onPress={() => setAutoCreateForFeature(!autoCreateForFeature)}
      />
      {props.role ? (
        <Action label={`Enabled: ${enabled ? "on" : "off"}`} onPress={() => setEnabled(!enabled)} />
      ) : null}
      <Action
        label="Save role"
        disabled={!canSave || props.busy}
        onPress={() => {
          const modelSelection: ModelSelection = {
            instanceId: ProviderInstanceId.make(instanceId.trim()),
            model: model.trim(),
            ...(props.role?.modelSelection.instanceId === instanceId.trim() &&
            props.role.modelSelection.model === model.trim() &&
            props.role.modelSelection.options
              ? { options: props.role.modelSelection.options }
              : {}),
          };
          void props
            .onSave({
              id: props.role?.id ?? `role:${uuidv4()}`,
              name: name.trim(),
              instructions: instructions.trim(),
              allowedTools: [...allowedTools],
              modelSelection,
              runtimeMode,
              autoCreateForFeature,
              enabled,
              ...(baseRevision !== undefined ? { expectedRevision: baseRevision } : {}),
            })
            .then((saved) => {
              if (saved && baseRevision !== undefined) setBaseRevision(baseRevision + 1);
            });
        }}
      />
    </View>
  );
}

function useRun(onSuccess: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    action: () => Promise<{ readonly _tag: string; readonly cause?: unknown }>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result._tag !== "Success") setError(Cause.pretty(result.cause as Cause.Cause<unknown>));
      else onSuccess();
      return result._tag === "Success";
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** An environment's roles, shared by every project: the starter set and the role editor. */
export function MobileRolesPanel(props: {
  readonly environmentId: EnvironmentId;
  /** The model new roles and the starter set default to. */
  readonly modelSelection: ModelSelection | null;
}) {
  const { environmentId } = props;
  const rolesQuery = useEnvironmentQuery(rolesEnvironment.roles({ environmentId, input: {} }));
  const initialize = useAtomCommand(rolesEnvironment.initialize);
  const create = useAtomCommand(rolesEnvironment.create);
  const update = useAtomCommand(rolesEnvironment.update);
  const [roleId, setRoleId] = useState<string | null>(null);
  const { busy, error, run } = useRun(rolesQuery.refresh);
  const roles = rolesQuery.data ?? [];
  const needsStarter =
    rolesQuery.data !== null && !roles.some((role) => role.id === PROJECT_MANAGER_ROLE_ID);
  const role = roles.find((item) => item.id === roleId) ?? null;

  return (
    <View className="gap-3 p-4">
      <Text className="text-xs text-foreground-muted">
        Roles are shared by every project. Edits apply to crew members created afterwards.
      </Text>
      {needsStarter ? (
        <Action
          label="Add starter roles"
          disabled={busy || !props.modelSelection}
          onPress={() => {
            if (props.modelSelection)
              void run(() =>
                initialize({
                  environmentId,
                  input: { modelSelection: props.modelSelection! },
                }),
              );
          }}
        />
      ) : null}
      {rolesQuery.error ? <Text className="text-sm text-red-500">{rolesQuery.error}</Text> : null}
      {error ? <Text className="text-sm text-red-500">{error}</Text> : null}
      <View className="flex-row flex-wrap gap-2">
        <Action label="New role" selected={roleId === null} onPress={() => setRoleId(null)} />
        {roles.map((item) => (
          <Action
            key={item.id}
            label={item.name}
            selected={roleId === item.id}
            onPress={() => setRoleId(item.id)}
          />
        ))}
      </View>
      <Editor
        key={role?.id ?? "new"}
        role={role}
        modelSelection={props.modelSelection}
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
            if (saved) setRoleId(value.id);
            return saved;
          });
        }}
      />
    </View>
  );
}

/**
 * One project's crew: add a member from a role, then place it in the hierarchy and choose
 * whom it may delegate to. Roles themselves are edited in Settings › Roles.
 */
export function MobileCrewMembersPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly members: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly projectId: ProjectId | null;
  }>;
}) {
  const { environmentId, projectId } = props;
  const rolesQuery = useEnvironmentQuery(rolesEnvironment.roles({ environmentId, input: {} }));
  const configuration = useEnvironmentQuery(
    rolesEnvironment.configuration({ environmentId, input: { projectId } }),
  );
  const instantiate = useAtomCommand(rolesEnvironment.instantiate);
  const setHierarchy = useAtomCommand(rolesEnvironment.setHierarchy);
  const setDelegation = useAtomCommand(rolesEnvironment.setDelegation);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const { busy, error, run } = useRun(configuration.refresh);
  const enabledRoles = (rolesQuery.data ?? []).filter((role) => role.enabled);
  const nodes = configuration.data?.hierarchy ?? [];
  const grants = configuration.data?.delegationGrants ?? [];
  const selectedMember = props.members.find((member) => member.id === memberId);
  const parentId = nodes.find((node) => node.memberId === memberId)?.parentMemberId ?? null;
  const granted = grants.some(
    (grant) => grant.sourceMemberId === memberId && grant.targetMemberId === targetId,
  );

  return (
    <View className="gap-3 border-t border-border-subtle pt-4">
      <Text className="text-sm font-t3-medium text-foreground">Crew members</Text>
      <Text className="text-xs text-foreground-muted">
        Add a crew member from a role, then choose its parent and whom it can delegate to.
      </Text>
      {rolesQuery.error || configuration.error ? (
        <Text className="text-sm text-red-500">{rolesQuery.error ?? configuration.error}</Text>
      ) : null}
      {error ? <Text className="text-sm text-red-500">{error}</Text> : null}
      {enabledRoles.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {enabledRoles.map((role) => (
            <Action
              key={role.id}
              label={`Add ${role.name}`}
              disabled={busy}
              onPress={() =>
                void run(() =>
                  instantiate({
                    environmentId,
                    input: { id: `member:${uuidv4()}`, projectId, roleId: role.id },
                  }),
                )
              }
            />
          ))}
        </View>
      ) : null}
      {props.members.length > 0 ? (
        <View className="gap-2 border-t border-border-subtle pt-3">
          <Text className="text-sm font-t3-medium text-foreground">Hierarchy</Text>
          <Text className="text-xs text-foreground-muted">
            Choose a crew member, then its parent. Peers share a parent.
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {props.members.map((member) => (
              <Action
                key={member.id}
                label={member.name}
                selected={memberId === member.id}
                onPress={() => {
                  setMemberId(member.id);
                  setTargetId(null);
                }}
              />
            ))}
          </View>
          {selectedMember?.projectId === projectId ? (
            <View className="flex-row flex-wrap gap-2">
              <Action
                label="Root"
                selected={parentId === null}
                disabled={busy}
                onPress={() =>
                  void run(() =>
                    setHierarchy({
                      environmentId,
                      input: {
                        projectId,
                        memberId: selectedMember.id,
                        parentMemberId: null,
                        position: 0,
                      },
                    }),
                  )
                }
              />
              {props.members
                .filter((member) => member.id !== selectedMember.id)
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
                            memberId: selectedMember.id,
                            parentMemberId: parent.id,
                            position: 0,
                          },
                        }),
                      )
                    }
                  />
                ))}
            </View>
          ) : null}
          {selectedMember ? (
            <View className="gap-2 border-t border-border-subtle pt-3">
              <Text className="text-xs text-foreground-muted">
                {selectedMember.name} can delegate to
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {props.members
                  .filter(
                    (member) => member.projectId === projectId && member.id !== selectedMember.id,
                  )
                  .map((member) => (
                    <Action
                      key={member.id}
                      label={member.name}
                      selected={targetId === member.id}
                      onPress={() => setTargetId(member.id)}
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
                          sourceMemberId: selectedMember.id,
                          targetMemberId: targetId,
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
