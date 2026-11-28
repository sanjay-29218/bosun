import {
  libraryImportState,
  PLANNER_ROLE_ID,
  ProviderInstanceId,
  type RoleConfig,
  type EnvironmentId,
  type LibraryPushTarget,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { uuidv4 } from "../../lib/uuid";
import { rolesEnvironment } from "../../state/roles";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlsoUpdateOnSheet,
  ImportFromAction,
  MobileImportBanner,
  MobileImportedOn,
  withUpdateDot,
} from "./MobileLibraryImport";
import { Action, useRun } from "./SettingsActions";

/** Two inputs as one model choice; both empty is none. */
const modelFrom = (
  instanceId: string,
  model: string,
  previous: ModelSelection | null | undefined,
): ModelSelection | null =>
  !instanceId.trim() || !model.trim()
    ? null
    : {
        instanceId: ProviderInstanceId.make(instanceId.trim()),
        model: model.trim(),
        ...(previous?.instanceId === instanceId.trim() &&
        previous.model === model.trim() &&
        previous.options
          ? { options: previous.options }
          : {}),
      };

function Editor(props: {
  readonly environmentId: EnvironmentId;
  readonly role: RoleConfig | null;
  readonly modelSelection: ModelSelection | null;
  readonly busy: boolean;
  readonly onChanged: () => void;
  readonly onSave: (value: {
    readonly id: string;
    readonly name: string;
    readonly instructions: string;
    readonly modelSelection: ModelSelection;
    readonly fallbackModelSelection: ModelSelection | null;
    readonly enabled: boolean;
    readonly expectedRevision?: number;
    readonly alsoUpdateOn?: ReadonlyArray<LibraryPushTarget>;
  }) => Promise<boolean>;
}) {
  const gt = useGT();
  const initialModel = props.role?.modelSelection ?? props.modelSelection;
  const initialFallback = props.role?.fallbackModelSelection ?? null;
  const [fallbackInstanceId, setFallbackInstanceId] = useState<string>(
    initialFallback?.instanceId ?? "",
  );
  const [fallbackModel, setFallbackModel] = useState(initialFallback?.model ?? "");
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState(props.role?.name ?? "");
  const [instructions, setInstructions] = useState(props.role?.instructions ?? "");
  const [instanceId, setInstanceId] = useState(initialModel?.instanceId ?? "");
  const [model, setModel] = useState(initialModel?.model ?? "");
  const [enabled, setEnabled] = useState(props.role?.enabled ?? true);
  // The fields above match this revision. If someone else saves a newer one, this save is
  // refused instead of overwriting it.
  const [baseRevision, setBaseRevision] = useState(props.role?.revision);
  const canSave = !!name.trim() && !!instructions.trim() && !!instanceId.trim() && !!model.trim();
  const fallbackNow = modelFrom(fallbackInstanceId, fallbackModel, initialFallback);
  const unsaved =
    props.role !== null &&
    (name !== props.role.name ||
      instructions !== props.role.instructions ||
      instanceId !== props.role.modelSelection.instanceId ||
      model !== props.role.modelSelection.model ||
      enabled !== props.role.enabled ||
      fallbackNow?.instanceId !== initialFallback?.instanceId ||
      fallbackNow?.model !== initialFallback?.model);

  const save = (alsoUpdateOn?: ReadonlyArray<LibraryPushTarget>) => {
    const modelSelection = modelFrom(instanceId, model, props.role?.modelSelection)!;
    setAsking(false);
    void props
      .onSave({
        id: props.role?.id ?? `role:${uuidv4()}`,
        name: name.trim(),
        instructions: instructions.trim(),
        modelSelection,
        fallbackModelSelection: modelFrom(
          fallbackInstanceId,
          fallbackModel,
          props.role?.fallbackModelSelection,
        ),
        enabled,
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
        {props.role?.name ?? gt("New role")}
      </Text>
      {props.role === null ? null : (
        <MobileImportBanner
          environmentId={props.environmentId}
          kind="role"
          item={props.role}
          unsaved={unsaved}
          onChanged={props.onChanged}
        />
      )}
      <AppTextInput
        accessibilityLabel={gt("Role name")}
        placeholder={gt("Name")}
        value={name}
        onChangeText={setName}
        maxLength={200}
      />
      <AppTextInput
        accessibilityLabel={gt("Role instructions")}
        placeholder={gt("Instructions")}
        value={instructions}
        onChangeText={setInstructions}
        maxLength={16000}
        multiline
        textAlignVertical="top"
        className="min-h-28"
      />
      <AppTextInput
        accessibilityLabel={gt("Role provider instance")}
        placeholder={gt("Provider instance")}
        value={instanceId}
        onChangeText={setInstanceId}
      />
      <AppTextInput
        accessibilityLabel={gt("Role model")}
        placeholder={gt("Model")}
        value={model}
        onChangeText={setModel}
      />
      <Text className="text-xs text-foreground-muted">
        {gt(
          "Fallback model: used when this role's model can't run here. Leave both empty to use the Settings fallback.",
        )}
      </Text>
      <AppTextInput
        accessibilityLabel={gt("Fallback provider instance")}
        placeholder={gt("Settings fallback")}
        value={fallbackInstanceId}
        onChangeText={setFallbackInstanceId}
      />
      <AppTextInput
        accessibilityLabel={gt("Fallback model")}
        placeholder={gt("Settings fallback")}
        value={fallbackModel}
        onChangeText={setFallbackModel}
      />
      {fallbackInstanceId || fallbackModel ? (
        <Action
          label={gt("Clear fallback")}
          onPress={() => {
            setFallbackInstanceId("");
            setFallbackModel("");
          }}
        />
      ) : null}
      {props.role ? (
        <Action
          label={enabled ? gt("Enabled: on") : gt("Enabled: off")}
          onPress={() => setEnabled(!enabled)}
        />
      ) : null}
      <Action
        label={gt("Save role")}
        disabled={!canSave || props.busy}
        onPress={() => {
          if (props.role && props.role.importers.length > 0) setAsking(true);
          else save();
        }}
      />
      {props.role === null ? null : <MobileImportedOn item={props.role} />}
      {asking && props.role ? (
        <AlsoUpdateOnSheet
          name={props.role.name}
          importers={props.role.importers}
          onCancel={() => setAsking(false)}
          onSave={save}
        />
      ) : null}
    </View>
  );
}

/** An environment's roles, shared by every project: the starter set and the role editor. */
export function MobileRolesPanel(props: {
  readonly environmentId: EnvironmentId;
  /** The model new roles and the starter set default to. */
  readonly modelSelection: ModelSelection | null;
}) {
  const gt = useGT();
  const { environmentId } = props;
  const rolesQuery = useEnvironmentQuery(rolesEnvironment.roles({ environmentId, input: {} }));
  const initialize = useAtomCommand(rolesEnvironment.initialize);
  const create = useAtomCommand(rolesEnvironment.create);
  const update = useAtomCommand(rolesEnvironment.update);
  const [roleId, setRoleId] = useState<string | null>(null);
  const { busy, error, run } = useRun(rolesQuery.refresh);
  const roles = rolesQuery.data ?? [];
  const needsStarter =
    rolesQuery.data !== null && !roles.some((role) => role.id === PLANNER_ROLE_ID);
  const role = roles.find((item) => item.id === roleId) ?? null;

  return (
    <View className="gap-3 p-4">
      <Text className="text-xs text-foreground-muted">
        <T>Roles are shared by every project. Edits apply to crew members created afterwards.</T>
      </Text>
      {needsStarter ? (
        <Action
          label={gt("Add starter roles")}
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
        <ImportFromAction environmentId={environmentId} />
        <Action label={gt("New role")} selected={roleId === null} onPress={() => setRoleId(null)} />
        {roles.map((item) => (
          <Action
            key={item.id}
            label={withUpdateDot(item.name, libraryImportState(item).updateAvailable)}
            selected={roleId === item.id}
            onPress={() => setRoleId(item.id)}
          />
        ))}
      </View>
      <Editor
        key={`${role?.id ?? "new"}:${role?.revision ?? 0}`}
        environmentId={environmentId}
        role={role}
        modelSelection={props.modelSelection}
        busy={busy}
        onChanged={rolesQuery.refresh}
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
  const gt = useGT();
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
      <Text className="text-sm font-t3-medium text-foreground">
        <T>Crew members</T>
      </Text>
      <Text className="text-xs text-foreground-muted">
        <T>Add a crew member from a role, then choose its parent and whom it can delegate to.</T>
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
              label={gt("Add {name}", { name: role.name })}
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
          <Text className="text-sm font-t3-medium text-foreground">
            <T>Hierarchy</T>
          </Text>
          <Text className="text-xs text-foreground-muted">
            <T>Choose a crew member, then its parent. Peers share a parent.</T>
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
                label={gt("Root", {
                  $context: "top of the crew hierarchy, a member with no parent",
                })}
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
                    label={gt("Under {name}", { name: parent.name })}
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
                <T>
                  <Var>{selectedMember.name}</Var> can delegate to
                </T>
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
                  label={granted ? gt("Remove delegation") : gt("Allow delegation")}
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
