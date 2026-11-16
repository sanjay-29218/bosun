import { useAtomValue } from "@effect/atom-react";
import {
  applyManagerPlacement,
  type ManagerCopy,
  managerCopiesOf,
  managerHomeAmong,
  onSeveralMachines,
  managerPermitted,
  planManagerPlacement,
} from "@t3tools/client-runtime/project-manager-home";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, PeerLinkSummary } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useNowMinuteMs } from "../../lib/clock";
import { useLogicalBots } from "../../state/bots";
import { useEnvironmentServerConfig, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { environmentServerConfigsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/**
 * A project's copies whose manager placement this client can change, with where the manager
 * lives among them; the home is null while it lives on a machine this client doesn't see.
 * `worksFrom` is the copy whose Can work on list applies, which a project on one machine has too.
 */
export function useManagerPlacement(members: ReadonlyArray<EnvironmentProject>) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const shells = useThreadShells();
  const bots = useLogicalBots();
  const { environments } = useEnvironments();
  const copies = managerCopiesOf({
    projects: members.filter(
      (member) => configs.get(member.environmentId)?.environment.capabilities.projectManagerHomes,
    ),
    labelOf: (environmentId) =>
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
      null,
    threads: shells,
    botPermitted: (owner) =>
      bots.find((bot) =>
        bot.members.some(
          (member) => member.environmentId === owner.environmentId && member.botId === owner.botId,
        ),
      )?.permittedEnvironmentIds ?? null,
  });
  const placed = copies.length === members.length && onSeveralMachines(copies);
  const home = placed ? managerHomeAmong(copies) : null;
  const worksFrom = home ?? (!placed && copies.length === 1 ? managerHomeAmong(copies) : null);
  return { copies, placed, home, worksFrom };
}

/**
 * Where the project's manager lives among its copies, when it has several, and every machine
 * linked to its home that it may work on.
 */
export function MobileProjectManagerPlacement(props: {
  readonly copies: ReadonlyArray<ManagerCopy>;
  readonly home: ManagerCopy;
  readonly placed: boolean;
}) {
  const { copies, home } = props;
  const offered = offersLinkedEnvironments(useEnvironmentServerConfig(home.environmentId));
  const links = useEnvironmentQuery(
    offered ? peerLinkEnvironment.list({ environmentId: home.environmentId, input: {} }) : null,
  );
  const place = useAtomCommand(rolesEnvironment.setProjectManagerPlacement, {
    reportFailure: false,
  });
  const canEdit = useAtomValue(
    rolesEnvironment.setProjectManagerPlacement.permissionAtom(home.environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const permitted = managerPermitted(home, copies);

  const run = async (plan: ReturnType<typeof planManagerPlacement>) => {
    setBusy(true);
    setError(null);
    const failure = await applyManagerPlacement(plan, copies, async ({ environmentId, input }) => {
      const result = await place({ environmentId, input });
      return result._tag === "Success"
        ? { ok: true, retiredThreadId: result.value.retiredThreadId }
        : { ok: false, failure: Cause.pretty(result.cause) };
    });
    setBusy(false);
    setError(failure);
  };

  const move = (environmentId: string) => {
    const next = copies.find((copy) => copy.environmentId === environmentId);
    if (next === undefined || next === home) return;
    Alert.alert(
      `Move the manager to ${next.label}?`,
      `Its thread on ${home.label} is archived, not deleted, and its open requests go back to their senders.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Move", onPress: () => void run(planManagerPlacement(copies, next)) },
      ],
    );
  };

  const toggle = (environmentId: EnvironmentId, on: boolean) =>
    void run({
      away: [],
      home: {
        environmentId: home.environmentId,
        input: {
          projectId: home.projectId,
          permittedEnvironmentIds: on
            ? [...permitted, environmentId]
            : permitted.filter((id) => id !== environmentId),
        },
      },
    });

  const held = new Set(copies.map((copy) => copy.environmentId));
  const now = DateTime.makeUnsafe(useNowMinuteMs());

  return (
    <SettingsSection title="Project manager">
      {props.placed ? (
        <View className="gap-2 p-4">
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-sm font-t3-medium text-foreground-muted">Lives on</Text>
            <Menu
              accessibilityLabel="Lives on"
              title="Lives on"
              actions={copies.map((copy) => ({
                id: copy.environmentId,
                title: copy.label,
                state: copy === home ? ("on" as const) : ("off" as const),
              }))}
              onPressAction={({ nativeEvent }) => {
                if (canEdit && !busy) move(nativeEvent.event);
              }}
            >
              <View className="rounded-full bg-subtle-strong px-3.5 py-1.5">
                <Text className="text-sm font-t3-medium text-foreground">{home.label} ▾</Text>
              </View>
            </Menu>
          </View>
          <Text className="text-sm text-foreground-muted">
            Its chat, settings and automations live there.
          </Text>
        </View>
      ) : null}
      <Text className="px-4 pt-3 text-sm text-foreground-muted">
        {!offered
          ? `Can work on: linked environments are off on ${home.label}. Turn them on in Settings → Labs.`
          : links.data?.links.length === 0
            ? `Can work on: no machines are linked to ${home.label} yet.`
            : `Can work on: machines linked to ${home.label} where the manager checks threads and features, talks to them, and starts work.`}
      </Text>
      {(links.data?.links ?? []).map((link) => (
        <SettingsSwitchRow
          key={link.environmentId}
          label={link.label}
          subtitle={machineStatus(link, now, held.has(link.environmentId))}
          value={permitted.includes(link.environmentId)}
          disabled={busy || !canEdit}
          onValueChange={(on) => toggle(link.environmentId, on)}
        />
      ))}
      {links.error ? <Text className="px-4 pb-3 text-sm text-red-500">{links.error}</Text> : null}
      {error ? <Text className="px-4 pb-3 text-sm text-red-500">{error}</Text> : null}
    </SettingsSection>
  );
}

/** Whether a linked machine answers, and whether it has a copy of the project. */
function machineStatus(link: PeerLinkSummary, now: DateTime.Utc, hasCopy: boolean) {
  const health = peerLinkHealth(link, now);
  const status =
    health.kind === "expired"
      ? "Expired. Link it again."
      : health.kind === "unreachable"
        ? (health.detail ?? "Not answering right now")
        : health.kind === "failing"
          ? health.detail
          : "Online";
  return hasCopy ? status : `${status} · No copy of this project there yet`;
}
