import { useAtomValue } from "@effect/atom-react";
import { libraryImportBanner, libraryImporterLine } from "@t3tools/client-runtime/state/library";
import type {
  EnvironmentId,
  ImportedFrom,
  LibraryImporter,
  LibraryItemKind,
  LibraryPushTarget,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { DownloadIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatEnvironmentQueryError } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { LinkEnvironmentAction } from "../settings/LinkedEnvironmentsSettings";
import { SettingsSection } from "../settings/settingsLayout";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ImportedItem {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly importedFrom: ImportedFrom | null;
}

/**
 * At the top of an imported workflow's or role's editor: where it came from, whether its source
 * has a newer one, and the ways out (take it, skip it, or keep this one as this machine's own).
 */
export function LibraryImportBanner({
  environmentId,
  kind,
  item,
  unsaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly kind: LibraryItemKind;
  readonly item: ImportedItem;
  readonly unsaved: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const importItems = useAtomCommand(rolesEnvironment.importItems, { reportFailure: false });
  const detach = useAtomCommand(rolesEnvironment.detach, { reportFailure: false });
  const canEdit = useAtomValue(rolesEnvironment.importItems.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const banner = libraryImportBanner(kind, item, m);
  const from = item.importedFrom;
  if (banner === null || from === null) return null;
  const machine = from.label;

  const take = async () => {
    setBusy(true);
    const result = await importItems({
      environmentId,
      input: {
        sourceEnvironmentId: from.environmentId,
        roleIds: kind === "role" ? [item.id] : [],
        workflowIds: kind === "workflow" ? [item.id] : [],
        replace: false,
      },
    });
    setBusy(false);
    toastManager.add(
      result._tag === "Success"
        ? { type: "success", title: gt("Took the update from {machine}", { machine }) }
        : {
            type: "error",
            title: gt("Could not take the update"),
            description: formatEnvironmentQueryError(result.cause),
          },
    );
  };
  const leave = async (mode: "skip" | "detach") => {
    if (mode === "detach") {
      const confirmed = await requestConfirmDialog(
        gt("Keep {name} as your own?\nIt stops showing updates from {machine}.", {
          name: item.name,
          machine,
        }),
      );
      if (confirmed !== true) return;
    }
    setBusy(true);
    const result = await detach({ environmentId, input: { kind, id: item.id, mode } });
    setBusy(false);
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title:
          mode === "skip" ? gt("Could not skip the update") : gt("Could not keep it as your own"),
        description: formatEnvironmentQueryError(result.cause),
      });
    }
  };

  const Icon =
    banner.variant === "warning"
      ? TriangleAlertIcon
      : banner.actions.includes("take")
        ? DownloadIcon
        : InfoIcon;
  const takeButton = (
    <Button
      size="xs"
      variant="outline"
      disabled={busy || unsaved || !canEdit}
      onClick={() => void take()}
    >
      <T>Take update</T>
    </Button>
  );
  return (
    <Alert variant={banner.variant}>
      <Icon />
      <AlertTitle>{banner.title}</AlertTitle>
      <AlertDescription>{banner.description}</AlertDescription>
      {canEdit ? (
        <AlertAction>
          {banner.actions.includes("take") ? (
            unsaved ? (
              <Tooltip>
                <TooltipTrigger render={<span />}>{takeButton}</TooltipTrigger>
                <TooltipPopup>
                  <T>Save or discard your changes first</T>
                </TooltipPopup>
              </Tooltip>
            ) : (
              takeButton
            )
          ) : null}
          {banner.actions.includes("skip") ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void leave("skip")}>
              <T>Skip</T>
            </Button>
          ) : null}
          {banner.actions.includes("link") ? (
            <LinkEnvironmentAction
              environmentId={environmentId}
              label={gt("Link {machine}", { machine })}
            />
          ) : null}
          {banner.actions.includes("detach") ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void leave("detach")}>
              <T>Keep as my own</T>
            </Button>
          ) : null}
        </AlertAction>
      ) : null}
    </Alert>
  );
}

/** On the source: the machines that imported it, as their last sync here reported them. */
export function LibraryImportedOn({
  item,
}: {
  readonly item: { readonly revision: number; readonly importers: ReadonlyArray<LibraryImporter> };
}) {
  const gt = useGT();
  const m = useMessages();
  const nowMinute = useNowMinute();
  if (item.importers.length === 0) return null;
  return (
    <SettingsSection title={gt("Imported on")}>
      <ul className="divide-y divide-border">
        {item.importers.map((importer) => (
          <li key={importer.environmentId} className="flex min-w-0 flex-col px-3 py-2.5 sm:px-4">
            <span className="truncate text-sm font-medium">{importer.label}</span>
            <span className="truncate text-xs text-muted-foreground">
              {libraryImporterLine(
                importer,
                item.revision,
                formatRelativeTimeLabel(importer.seenAt, Date.parse(nowMinute), m),
                m,
              )}
            </span>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}

/**
 * Saving a workflow or role that linked machines imported: which of them take this change on
 * their next sync. One with local edits starts unticked, since taking it replaces them.
 */
export function AlsoUpdateOnDialog({
  name,
  importers,
  open,
  onCancel,
  onSave,
}: {
  readonly name: string;
  readonly importers: ReadonlyArray<LibraryImporter>;
  readonly open: boolean;
  readonly onCancel: () => void;
  readonly onSave: (alsoUpdateOn: ReadonlyArray<LibraryPushTarget>) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogPopup>
        {open ? (
          <AlsoUpdateOnForm name={name} importers={importers} onCancel={onCancel} onSave={onSave} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function AlsoUpdateOnForm({
  name,
  importers,
  onCancel,
  onSave,
}: {
  readonly name: string;
  readonly importers: ReadonlyArray<LibraryImporter>;
  readonly onCancel: () => void;
  readonly onSave: (alsoUpdateOn: ReadonlyArray<LibraryPushTarget>) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const nowMinute = useNowMinute();
  // What the person is shown is what they agree to, even if a sync changes it meanwhile.
  const [shown] = useState(importers);
  const [ticked, setTicked] = useState<ReadonlySet<EnvironmentId>>(
    () =>
      new Set(
        shown.filter((importer) => !importer.edited).map((importer) => importer.environmentId),
      ),
  );
  const machines = shown.map((importer) => importer.label).join(", ");
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <T>Also update on</T>
        </DialogTitle>
        <DialogDescription>
          {gt(
            "{machines} imported {name}. Ticked machines take this change within a minute; the rest see Update available.",
            { machines, name },
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ul className="divide-y divide-border rounded-lg border bg-card">
          {shown.map((importer) => {
            const checked = ticked.has(importer.environmentId);
            const lastSeen = formatRelativeTimeLabel(importer.seenAt, Date.parse(nowMinute), m);
            return (
              <li key={importer.environmentId}>
                <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
                  <Checkbox
                    className="mt-0.5"
                    checked={checked}
                    onCheckedChange={(next) =>
                      setTicked((current) => {
                        const updated = new Set(current);
                        if (next === true) updated.add(importer.environmentId);
                        else updated.delete(importer.environmentId);
                        return updated;
                      })
                    }
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{importer.label}</span>
                    {importer.edited ? (
                      <span className="text-xs text-warning-foreground">
                        <T>Has local edits. Updating replaces them.</T>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        <T>
                          Has an older version · last seen <Var>{lastSeen}</Var>
                        </T>
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          <T>Cancel</T>
        </Button>
        <Button
          onClick={() =>
            onSave(
              shown
                .filter((importer) => ticked.has(importer.environmentId))
                .map((importer) => ({
                  environmentId: importer.environmentId,
                  replacesEdits: importer.edited,
                })),
            )
          }
        >
          {ticked.size === 0 ? gt("Save") : gt("Save and update {count}", { count: ticked.size })}
        </Button>
      </DialogFooter>
    </>
  );
}
