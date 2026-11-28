import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { libraryImportBanner, libraryImporterLine } from "@t3tools/client-runtime/state/library";
import type {
  EnvironmentId,
  ImportedFrom,
  LibraryImporter,
  LibraryItemKind,
  LibraryPushTarget,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Modal, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironments } from "../../state/environments";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { Action, useRun } from "./SettingsActions";

/**
 * Whether this client may import into `environmentId`: its server serves imports and this
 * client may change its library.
 */
export function useCanImport(environmentId: EnvironmentId) {
  const { environments } = useEnvironments();
  const permitted = useAtomValue(rolesEnvironment.importItems.permissionAtom(environmentId));
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  return permitted && environment?.serverConfig?.environment.capabilities.libraryImports === true;
}

/** Opens the import screen for `environmentId`'s library. */
export function ImportFromAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const navigation = useNavigation();
  if (!useCanImport(environmentId)) return null;
  return (
    <Action
      label={gt("Import from…")}
      onPress={() => navigation.navigate("SettingsLibraryImport", { environmentId })}
    />
  );
}

/** A pill's label for an imported one whose source has a newer version. */
export const withUpdateDot = (name: string, updateAvailable: boolean) =>
  updateAvailable ? `${name} •` : name;

interface ImportedItem {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly importedFrom: ImportedFrom | null;
}

/** At the top of an imported one's editor: its source, its update, and the ways out. */
export function MobileImportBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly kind: LibraryItemKind;
  readonly item: ImportedItem;
  /** The editor has changes Take update would throw away. */
  readonly unsaved: boolean;
  readonly onChanged: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const importItems = useAtomCommand(rolesEnvironment.importItems);
  const detach = useAtomCommand(rolesEnvironment.detach);
  const { busy, error, run } = useRun(props.onChanged);
  const banner = libraryImportBanner(props.kind, props.item, m);
  const from = props.item.importedFrom;
  if (banner === null || from === null) return null;
  const tone =
    banner.variant === "warning"
      ? "text-amber-600"
      : banner.variant === "info"
        ? "text-sky-600"
        : "text-foreground";
  return (
    <View className="gap-1.5 rounded-lg bg-subtle p-2.5">
      <Text className={`text-sm font-t3-medium ${tone}`}>{banner.title}</Text>
      <Text className="text-xs text-foreground-muted">{banner.description}</Text>
      {error ? <Text className="text-xs text-red-500">{error}</Text> : null}
      {props.unsaved && banner.actions.includes("take") ? (
        <Text className="text-xs text-foreground-muted">
          <T>Save or discard your changes first</T>
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2 pt-1">
        {banner.actions.includes("take") ? (
          <Action
            label={gt("Take update")}
            disabled={busy || props.unsaved}
            onPress={() =>
              void run(() =>
                importItems({
                  environmentId: props.environmentId,
                  input: {
                    sourceEnvironmentId: from.environmentId,
                    roleIds: props.kind === "role" ? [props.item.id] : [],
                    workflowIds: props.kind === "workflow" ? [props.item.id] : [],
                    replace: false,
                  },
                }),
              )
            }
          />
        ) : null}
        {banner.actions.includes("skip") ? (
          <Action
            label={gt("Skip")}
            disabled={busy}
            onPress={() =>
              void run(() =>
                detach({
                  environmentId: props.environmentId,
                  input: { kind: props.kind, id: props.item.id, mode: "skip" },
                }),
              )
            }
          />
        ) : null}
        {banner.actions.includes("detach") ? (
          <Action
            label={gt("Keep as my own")}
            disabled={busy}
            onPress={() =>
              Dialog.confirm({
                title: gt("Keep {name} as your own?", { name: props.item.name }),
                message: gt("It stops showing updates from {machine}.", { machine: from.label }),
                confirmText: gt("Keep as my own"),
                onConfirm: () =>
                  void run(() =>
                    detach({
                      environmentId: props.environmentId,
                      input: { kind: props.kind, id: props.item.id, mode: "detach" },
                    }),
                  ),
              })
            }
          />
        ) : null}
      </View>
    </View>
  );
}

/** On the source: the machines that imported it. */
export function MobileImportedOn(props: {
  readonly item: { readonly revision: number; readonly importers: ReadonlyArray<LibraryImporter> };
}) {
  const m = useMessages();
  const nowMs = useNowMinuteMs();
  if (props.item.importers.length === 0) return null;
  return (
    <View className="gap-1 border-t border-border-subtle pt-2">
      <Text className="text-xs font-t3-medium text-foreground-muted">
        <T>Imported on</T>
      </Text>
      {props.item.importers.map((importer) => (
        <View key={importer.environmentId}>
          <Text className="text-sm text-foreground">{importer.label}</Text>
          <Text className="text-xs text-foreground-muted">
            {libraryImporterLine(
              importer,
              props.item.revision,
              relativeTime(importer.seenAt, nowMs, m),
              m,
            )}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Saving one that linked machines imported: which of them take the change on their next sync.
 * One with local edits starts off, since taking it replaces them.
 */
export function AlsoUpdateOnSheet(props: {
  readonly name: string;
  readonly importers: ReadonlyArray<LibraryImporter>;
  readonly onCancel: () => void;
  readonly onSave: (alsoUpdateOn: ReadonlyArray<LibraryPushTarget>) => void;
}) {
  const gt = useGT();
  // What the person is shown is what they agree to, even if a sync changes it meanwhile.
  const [shown] = useState(props.importers);
  const [ticked, setTicked] = useState<ReadonlySet<EnvironmentId>>(
    () =>
      new Set(
        shown.filter((importer) => !importer.edited).map((importer) => importer.environmentId),
      ),
  );
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={props.onCancel}
    >
      <SafeAreaProvider style={{ flex: 1 }}>
        <SafeAreaView style={{ flex: 1 }}>
          <View className="flex-1 gap-3 bg-screen p-5">
            <Text className="text-lg font-t3-medium text-foreground">
              <T>Also update on</T>
            </Text>
            <Text className="text-sm text-foreground-muted">
              {gt(
                "{machines} imported {name}. Turned-on machines take this change within a minute; the rest see Update available.",
                {
                  machines: shown.map((importer) => importer.label).join(", "),
                  name: props.name,
                },
              )}
            </Text>
            {shown.map((importer) => {
              const on = ticked.has(importer.environmentId);
              return (
                <View key={importer.environmentId} className="gap-1">
                  <Action
                    label={
                      on
                        ? gt("{machine}: on", { machine: importer.label })
                        : gt("{machine}: off", { machine: importer.label })
                    }
                    selected={on}
                    onPress={() =>
                      setTicked((current) => {
                        const next = new Set(current);
                        if (on) next.delete(importer.environmentId);
                        else next.add(importer.environmentId);
                        return next;
                      })
                    }
                  />
                  {importer.edited ? (
                    <Text className="text-xs text-amber-600">
                      <T>Has local edits. Updating replaces them.</T>
                    </Text>
                  ) : null}
                </View>
              );
            })}
            <View className="flex-row flex-wrap gap-2 pt-2">
              <Action label={gt("Cancel")} onPress={props.onCancel} />
              <Action
                label={
                  ticked.size === 0
                    ? gt("Save")
                    : gt("Save and update {count}", { count: ticked.size })
                }
                selected
                onPress={() =>
                  props.onSave(
                    shown
                      .filter((importer) => ticked.has(importer.environmentId))
                      .map((importer) => ({
                        environmentId: importer.environmentId,
                        replacesEdits: importer.edited,
                      })),
                  )
                }
              />
            </View>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}
