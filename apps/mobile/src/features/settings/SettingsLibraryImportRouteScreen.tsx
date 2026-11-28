import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import {
  libraryImportDefaults,
  libraryImportKey,
  libraryImportButtonLabel,
  libraryImportSelection,
  libraryReplaceWarning,
} from "@t3tools/client-runtime/state/library";
import type { EnvironmentId, LibraryImportable, LibraryImportableItem } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useCanImport } from "./MobileLibraryImport";
import { Action } from "./SettingsActions";

/**
 * Imports workflows and roles into one environment from a machine it links to: pick the machine,
 * then what to bring. A workflow brings the roles it needs that this environment lacks.
 */
export function SettingsLibraryImportRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  const { environmentId } = route.params;
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const here = environment?.label ?? gt("This environment");
  const canImport = useCanImport(environmentId);
  const offered = canImport && offersLinkedEnvironments(environment?.serverConfig);
  const links = useEnvironmentQuery(
    offered ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const importable = useAtomCommand(rolesEnvironment.importable);
  const importItems = useAtomCommand(rolesEnvironment.importItems);
  const [listed, setListed] = useState<LibraryImportable | null>(null);
  const [checking, setChecking] = useState<EnvironmentId | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (source: EnvironmentId) => {
    setChecking(source);
    setListed(null);
    setError(null);
    const result = await importable({ environmentId, input: { sourceEnvironmentId: source } });
    setChecking(null);
    if (result._tag !== "Success") {
      setError(Cause.pretty(result.cause as Cause.Cause<unknown>));
      return;
    }
    setTicked(libraryImportDefaults(result.value.items));
    setListed(result.value);
  };
  const items = listed?.items ?? [];
  const { neededBy, chosen, replacing } = libraryImportSelection(items, ticked);
  const submit = async () => {
    if (listed === null || chosen.length === 0) return;
    setRunning(true);
    setError(null);
    const result = await importItems({
      environmentId,
      input: {
        sourceEnvironmentId: listed.source.environmentId,
        roleIds: chosen.filter((item) => item.kind === "role").map((item) => item.id),
        workflowIds: chosen.filter((item) => item.kind === "workflow").map((item) => item.id),
        replace: replacing.length > 0,
      },
    });
    setRunning(false);
    if (result._tag !== "Success") {
      setError(Cause.pretty(result.cause as Cause.Cause<unknown>));
      return;
    }
    navigation.goBack();
  };

  const noteOf = (item: LibraryImportableItem) => {
    if (item.status === "current") return gt("Already up to date");
    if (item.status === "update") return gt("Update available");
    if (item.kind === "role" && neededBy.has(item.id) && !ticked.has(libraryImportKey(item))) {
      return gt("Needed by {workflow}", { workflow: neededBy.get(item.id) ?? "" });
    }
    const replaces = item.replaces;
    if (replaces === null) return gt("Not on {machine}", { machine: here });
    if (replaces.importedFrom !== null) {
      return gt("Replaces your {name} from {machine}", {
        name: replaces.name,
        machine: replaces.importedFrom,
      });
    }
    return replaces.stock
      ? gt("Replaces the starter {name}", { name: replaces.name })
      : gt("Replaces your {name}", { name: replaces.name });
  };
  const itemRows = (kind: LibraryImportableItem["kind"]) =>
    items
      .filter((item) => item.kind === kind)
      .map((item) => {
        const key = libraryImportKey(item);
        const locked = item.status === "current" || (item.kind === "role" && neededBy.has(item.id));
        const on = item.status === "current" || ticked.has(key) || locked;
        return (
          <View key={key} className="gap-1">
            <Action
              label={on ? `✓ ${item.name}` : item.name}
              selected={on}
              disabled={locked || running}
              onPress={() =>
                setTicked((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            />
            <Text className="px-3 text-xs text-foreground-muted">{noteOf(item)}</Text>
          </View>
        );
      });

  const list = links.data?.links ?? null;
  return (
    <SettingsScreen title={gt("Import from…")}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="text-sm text-foreground-muted">
          {gt(
            "Into {machine}. You can edit what you import. When the original changes, it shows Update available.",
            { machine: here },
          )}
        </Text>
        {!canImport ? (
          <Text className="text-foreground-muted">
            {gt(
              "Importing into {machine} isn't available here. Update Bosun there, or connect with access that can change its workflows and roles.",
              { machine: here },
            )}
          </Text>
        ) : !offered ? (
          <Text className="text-foreground-muted">
            {gt("Linked environments are off on {machine}. Turn them on in Settings → Labs.", {
              machine: here,
            })}
          </Text>
        ) : list === null ? (
          <Text className="text-foreground-muted">
            {links.error ?? <T>Loading linked machines…</T>}
          </Text>
        ) : list.length === 0 ? (
          <Text className="text-foreground-muted">
            <T>No linked machines. Link another machine running Bosun first.</T>
          </Text>
        ) : (
          <SettingsSection title={gt("From")}>
            <View className="flex-row flex-wrap gap-2 p-4">
              {list.map((link) => (
                <Action
                  key={link.environmentId}
                  label={link.label}
                  selected={listed?.source.environmentId === link.environmentId}
                  disabled={link.status !== "reachable" || checking !== null || running}
                  onPress={() => void pick(link.environmentId)}
                />
              ))}
            </View>
          </SettingsSection>
        )}
        {checking !== null ? (
          <Text className="text-foreground-muted">
            <T>Checking…</T>
          </Text>
        ) : null}
        {listed !== null && listed.problem !== null ? (
          <Text className="text-amber-600">
            {listed.problem === "outdated"
              ? gt("Update Bosun on {machine} to import from it.", { machine: listed.source.label })
              : listed.problem === "denied"
                ? gt("Importing from {machine} needs a full-access link.", {
                    machine: listed.source.label,
                  })
                : gt("{machine} didn't answer. Try again when it's on.", {
                    machine: listed.source.label,
                  })}
          </Text>
        ) : null}
        {listed !== null && listed.problem === null ? (
          <>
            {items.some((item) => item.kind === "workflow") ? (
              <SettingsSection
                title={gt("Workflows on {machine}", { machine: listed.source.label })}
              >
                <View className="gap-2 p-4">{itemRows("workflow")}</View>
              </SettingsSection>
            ) : null}
            {items.some((item) => item.kind === "role") ? (
              <SettingsSection title={gt("Roles on {machine}", { machine: listed.source.label })}>
                <View className="gap-2 p-4">{itemRows("role")}</View>
              </SettingsSection>
            ) : null}
            {replacing.length > 0 ? (
              <Text className="text-amber-600">{libraryReplaceWarning(replacing, here, m)}</Text>
            ) : null}
            <Action
              label={
                running
                  ? gt("Importing…")
                  : replacing.length > 0
                    ? gt("Import and replace")
                    : chosen.length === 0
                      ? gt("Import")
                      : libraryImportButtonLabel(chosen, m)
              }
              selected
              disabled={running || chosen.length === 0}
              onPress={() => void submit()}
            />
          </>
        ) : null}
        {error ? <Text className="text-sm text-red-500">{error}</Text> : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
