import { useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import type {
  EnvironmentId,
  WorkflowConfig,
  WorkflowShare,
  WorkflowShareRoleChoice,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { Action } from "./MobileRoleConfigurationPanel";

const statusOf = (share: WorkflowShare | undefined, label: string, linked: boolean) => {
  if (share === undefined) return undefined;
  if (!linked) return "Not linked any more";
  const synced = share.syncedAt === null ? null : new Date(share.syncedAt).toLocaleString();
  switch (share.state) {
    case "removing":
      return `Removing when ${label} answers`;
    case "clash":
      return "Waiting on your choice below";
    case "synced":
      return `Up to date, synced ${synced}`;
    case "pending":
      return (
        share.error ??
        (synced === null ? `Waiting for ${label}` : `Update waiting for ${label}, last ${synced}`)
      );
  }
};

/**
 * The linked machines that get this workflow and the roles it uses, as on web: a switch per
 * machine that saves at once, its sync state, and a choice for each role it already has.
 */
export function MobileWorkflowMachines(props: {
  readonly environmentId: EnvironmentId;
  readonly workflow: WorkflowConfig;
}) {
  const { environmentId, workflow } = props;
  const { environments } = useEnvironments();
  const config = environments.find(
    (environment) => environment.environmentId === environmentId,
  )?.serverConfig;
  const supported =
    config?.environment.capabilities.workflowSharing === true && offersLinkedEnvironments(config);
  const links = useEnvironmentQuery(
    supported ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const shares = useEnvironmentQuery(
    supported
      ? rolesEnvironment.shares({ environmentId, input: { workflowId: workflow.id } })
      : null,
  );
  const canShare = useAtomValue(rolesEnvironment.setShare.permissionAtom(environmentId));
  const setShare = useAtomCommand(rolesEnvironment.setShare, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!supported) return null;

  const send = async (
    machine: { readonly environmentId: EnvironmentId; readonly label: string },
    change: {
      readonly shared: boolean;
      readonly roleChoices?: Record<string, WorkflowShareRoleChoice>;
      readonly confirmed?: boolean;
    },
  ) => {
    setBusy(true);
    setError(null);
    const result = await setShare({
      environmentId,
      input: {
        workflowId: workflow.id,
        environmentId: machine.environmentId,
        label: machine.label,
        ...change,
      },
    });
    setBusy(false);
    if (result._tag === "Success") return result.value;
    setError(Cause.pretty(result.cause));
    return null;
  };

  const toggle = async (
    machine: { readonly environmentId: EnvironmentId; readonly label: string },
    shared: boolean,
  ) => {
    const result = await send(machine, { shared });
    if (result === null || result.applied) return;
    Alert.alert(
      `Remove ${workflow.name} from ${machine.label}?`,
      `${result.openFeatures.map((feature) => `“${feature.title}”`).join(", ")} still running on it there will keep going.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => void send(machine, { shared: false, confirmed: true }),
        },
      ],
    );
  };

  const listed = links.data?.links ?? [];
  const shareList = shares.data ?? [];
  const machines = [
    ...listed.map((link) => ({
      environmentId: link.environmentId,
      label: link.label,
      linked: true,
    })),
    ...shareList
      .filter((share) => !listed.some((link) => link.environmentId === share.environmentId))
      .map((share) => ({ environmentId: share.environmentId, label: share.label, linked: false })),
  ];

  return (
    <View className="gap-2">
      <Text className="text-xs text-foreground-muted">
        Machines: linked machines that get this workflow and the roles it uses. Their copies follow
        edits made here.
      </Text>
      {machines.length === 0 ? (
        <Text className="text-sm text-foreground-muted">No linked machines.</Text>
      ) : null}
      {machines.map((machine) => {
        const share = shareList.find((entry) => entry.environmentId === machine.environmentId);
        return (
          <View key={machine.environmentId} className="gap-1.5">
            <SettingsSwitchRow
              label={machine.label}
              subtitle={statusOf(share, machine.label, machine.linked)}
              value={share?.shared === true}
              disabled={busy || !canShare}
              onValueChange={(on) => void toggle(machine, on)}
            />
            {share?.state === "clash"
              ? share.clashes.map((clash) => (
                  <View key={clash.id} className="gap-1.5 px-1">
                    <Text className="text-xs text-foreground-muted">
                      {machine.label} already has its own role {clash.name} with other settings.
                    </Text>
                    <View className="flex-row flex-wrap gap-2">
                      {(["keep", "replace"] as const).map((choice) => (
                        <Action
                          key={choice}
                          label={choice === "keep" ? `Keep ${machine.label}'s` : "Replace it"}
                          disabled={busy || !canShare}
                          onPress={() =>
                            void send(machine, {
                              shared: true,
                              roleChoices: { ...share.roleChoices, [clash.id]: choice },
                            })
                          }
                        />
                      ))}
                    </View>
                  </View>
                ))
              : null}
          </View>
        );
      })}
      {error ? <Text className="text-sm text-red-500">{error}</Text> : null}
    </View>
  );
}
