import { useAtomValue } from "@effect/atom-react";
import {
  EPIC_WORKFLOW_ID,
  FEATURE_DELIVERY_WORKFLOW_ID,
  type EnvironmentId,
  type LibraryOwner,
  type WorkflowConfig,
  type WorkflowShare,
  type WorkflowShareRoleChoice,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MonitorSmartphoneIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { offersLinkedEnvironmentsAtom, peerLinkEnvironment } from "../../state/peerLinks";
import { environmentPresentations } from "../../state/presentation";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { LinkEnvironmentAction } from "../settings/LinkedEnvironmentsSettings";
import { SettingsSection } from "../settings/settingsLayout";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";

/** A shared copy, or a role that came with one: it changes only where it's managed from. */
export function ManagedFromAlert({
  owner,
  kind,
}: {
  readonly owner: LibraryOwner;
  readonly kind: "workflow" | "role";
}) {
  return (
    <Alert variant="info">
      <MonitorSmartphoneIcon />
      <AlertTitle>Managed from {owner.label}</AlertTitle>
      <AlertDescription>
        {kind === "workflow"
          ? `${owner.label} shares this workflow here. Change it there; its edits arrive here by themselves.`
          : `This role came with a workflow ${owner.label} shares here. Change it there.`}
      </AlertDescription>
    </Alert>
  );
}

/** Feature delivery and Epic are on every machine, so they aren't shared over each other. */
export const isShareableWorkflow = (workflow: WorkflowConfig) =>
  workflow.managedBy == null &&
  workflow.id !== FEATURE_DELIVERY_WORKFLOW_ID &&
  workflow.id !== EPIC_WORKFLOW_ID;

/**
 * The linked machines that get this workflow and the roles it uses, each ticked on the machine
 * that owns it. A tick saves at once, and the copy there follows edits made here.
 */
export function WorkflowMachines({
  environmentId,
  workflow,
}: {
  readonly environmentId: EnvironmentId;
  readonly workflow: WorkflowConfig;
}) {
  const configs = useAtomValue(environmentPresentations.serverConfigsAtom);
  const supported = configs.get(environmentId)?.environment.capabilities.workflowSharing === true;
  const offered = useAtomValue(offersLinkedEnvironmentsAtom(environmentId));
  const links = useEnvironmentQuery(
    supported && offered ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const shares = useEnvironmentQuery(
    supported && offered
      ? rolesEnvironment.shares({ environmentId, input: { workflowId: workflow.id } })
      : null,
  );
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  const canShare = useAtomValue(rolesEnvironment.setShare.permissionAtom(environmentId));
  const setShare = useAtomCommand(rolesEnvironment.setShare);
  const [busy, setBusy] = useState(false);

  if (!supported) return null;

  const send = async (
    machine: { readonly environmentId: EnvironmentId; readonly label: string },
    change: {
      readonly shared: boolean;
      readonly roleChoices?: Record<string, WorkflowShareRoleChoice>;
      readonly confirmed?: boolean;
    },
  ) => {
    const result = await setShare({
      environmentId,
      input: {
        workflowId: workflow.id,
        environmentId: machine.environmentId,
        label: machine.label,
        ...change,
      },
    });
    if (result._tag === "Success") return result.value;
    toastManager.add({
      type: "error",
      title: change.shared
        ? `Could not share ${workflow.name} with ${machine.label}`
        : `Could not remove ${workflow.name} from ${machine.label}`,
      description: formatEnvironmentQueryError(result.cause),
    });
    return null;
  };

  const toggle = async (
    machine: { readonly environmentId: EnvironmentId; readonly label: string },
    shared: boolean,
  ) => {
    setBusy(true);
    const result = await send(machine, { shared });
    if (result !== null && !result.applied) {
      const titles = result.openFeatures.map((feature) => `“${feature.title}”`).join(", ");
      const confirmed = await requestConfirmDialog(
        `Remove ${workflow.name} from ${machine.label}?\n${titles} still ${result.openFeatures.length === 1 ? "runs" : "run"} on it there and ${result.openFeatures.length === 1 ? "keeps" : "keep"} going.`,
        { variant: "destructive" },
      );
      if (confirmed === true) await send(machine, { shared: false, confirmed: true });
    }
    setBusy(false);
  };

  const choose = async (share: WorkflowShare, roleId: string, choice: WorkflowShareRoleChoice) => {
    setBusy(true);
    await send(share, { shared: true, roleChoices: { ...share.roleChoices, [roleId]: choice } });
    setBusy(false);
  };

  const description =
    "Linked machines that get this workflow and the roles it uses. Their copies follow your edits here and can't be changed there.";

  if (!offered) {
    return (
      <SettingsSection title="Machines">
        <p className="px-3 py-4 text-sm text-muted-foreground sm:px-4">
          Linked environments are off on this machine. Turn them on in{" "}
          <Link to="/settings/labs" className="underline underline-offset-2">
            Settings → Labs
          </Link>{" "}
          to share this workflow with your other machines.
        </p>
      </SettingsSection>
    );
  }

  const listed = links.data?.links ?? null;
  const shareList = shares.data ?? [];
  // Machines it's shared with that are no longer linked still show, so they can be unticked.
  const machines = [
    ...(listed ?? []).map((link) => ({
      environmentId: link.environmentId,
      label: link.label,
      linked: true,
      reachable: link.status === "reachable",
    })),
    ...shareList
      .filter((share) => !listed?.some((link) => link.environmentId === share.environmentId))
      .map((share) => ({
        environmentId: share.environmentId,
        label: share.label,
        linked: false,
        reachable: false,
      })),
  ];

  return (
    <SettingsSection title="Machines">
      <div className="space-y-3 px-3 py-4 sm:px-4">
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs text-muted-foreground">{description}</p>
          {canLink ? (
            <LinkEnvironmentAction environmentId={environmentId} label="Link a machine" />
          ) : null}
        </div>
        {links.error ? (
          <p className="text-xs text-destructive" role="status">
            Could not load linked machines: {links.error}
          </p>
        ) : listed === null ? (
          <p className="text-xs text-muted-foreground" role="status">
            Loading linked machines…
          </p>
        ) : machines.length === 0 ? (
          <div className="rounded-lg border border-dashed">
            <Empty size="compact">
              <EmptyHeader>
                <EmptyTitle>No linked machines</EmptyTitle>
                <EmptyDescription>
                  Link another machine running Bosun to use {workflow.name} there too.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-lg border bg-card" aria-label="Machines">
            {machines.map((machine) => {
              const share = shareList.find(
                (entry) => entry.environmentId === machine.environmentId,
              );
              return (
                <MachineRow
                  key={machine.environmentId}
                  machine={machine}
                  share={share}
                  disabled={busy || !canShare}
                  onToggle={(shared) => void toggle(machine, shared)}
                  onChoose={(roleId, choice) =>
                    share === undefined ? undefined : void choose(share, roleId, choice)
                  }
                />
              );
            })}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}

function MachineRow({
  machine,
  share,
  disabled,
  onToggle,
  onChoose,
}: {
  readonly machine: {
    readonly label: string;
    readonly linked: boolean;
    readonly reachable: boolean;
  };
  readonly share: WorkflowShare | undefined;
  readonly disabled: boolean;
  readonly onToggle: (shared: boolean) => void;
  readonly onChoose: (roleId: string, choice: WorkflowShareRoleChoice) => void;
}) {
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const synced = share?.syncedAt ? `synced ${formatRelativeTimeLabel(share.syncedAt, now)}` : null;
  const status =
    share === undefined
      ? machine.reachable
        ? null
        : "Not answering right now"
      : !machine.linked
        ? "Not linked any more"
        : share.state === "removing"
          ? `Removing when ${machine.label} answers`
          : share.state === "clash"
            ? "Waiting on your choice below"
            : share.state === "synced"
              ? `Up to date, ${synced}`
              : (share.error ??
                (synced === null
                  ? `Waiting for ${machine.label}`
                  : `Update waiting for ${machine.label}, last ${synced}`));
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
        <Checkbox
          checked={share?.shared === true}
          disabled={disabled}
          onCheckedChange={(next) => onToggle(next === true)}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{machine.label}</span>
        {status === null ? null : (
          <span
            className={
              share?.error && share.state === "pending"
                ? "min-w-0 truncate text-xs text-destructive"
                : "min-w-0 truncate text-xs text-muted-foreground"
            }
          >
            {status}
          </span>
        )}
      </label>
      {share?.state === "clash" ? (
        <ul className="space-y-2 px-3 pb-3">
          {share.clashes.map((clash) => (
            <li
              key={clash.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/32 bg-warning-surface px-3 py-2"
            >
              <span className="min-w-0 text-xs text-warning-foreground">
                {machine.label} already has its own role {clash.name} ({clash.id}) with other
                settings.
              </span>
              <span className="flex gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onChoose(clash.id, "keep")}
                >
                  Keep {machine.label}'s
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onChoose(clash.id, "replace")}
                >
                  Replace with this one
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
