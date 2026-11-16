import { useAtomValue } from "@effect/atom-react";
import {
  applyManagerPlacement,
  type ManagerCopy,
  managerCopiesOf,
  managerHomeAmong,
  onSeveralMachines,
  planManagerPlacement,
} from "@t3tools/client-runtime/project-manager-home";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { rolesEnvironment } from "../../state/roles";
import { environmentServerConfigsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

/**
 * A project's copies whose manager placement this client can change, with where the manager
 * lives among them; the home is null while it lives on a machine this client doesn't see.
 */
export function useManagerPlacement(members: ReadonlyArray<EnvironmentProject>) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const shells = useThreadShells();
  const { environments } = useEnvironments();
  const copies = managerCopiesOf({
    projects: members.filter(
      (member) => configs.get(member.environmentId)?.environment.capabilities.projectManagerHomes,
    ),
    labelOf: (environmentId) =>
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
      null,
    threads: shells,
  });
  const placed = copies.length === members.length && onSeveralMachines(copies);
  return { copies, placed, home: placed ? managerHomeAmong(copies) : null };
}

/**
 * Where the project's manager lives among its copies. Every manager works on every machine linked
 * to its home, so there is nothing else to pick.
 */
export function MobileProjectManagerPlacement(props: {
  readonly copies: ReadonlyArray<ManagerCopy>;
  readonly home: ManagerCopy;
}) {
  const { copies, home } = props;
  const place = useAtomCommand(rolesEnvironment.setProjectManagerPlacement, {
    reportFailure: false,
  });
  const canEdit = useAtomValue(
    rolesEnvironment.setProjectManagerPlacement.permissionAtom(home.environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <SettingsSection title="Project manager">
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
          Its chat, settings and automations live there. It works on every machine linked to it.
        </Text>
      </View>
      {error ? <Text className="px-4 pb-3 text-sm text-red-500">{error}</Text> : null}
    </SettingsSection>
  );
}
