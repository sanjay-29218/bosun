import { useAtomValue } from "@effect/atom-react";
import {
  libraryImportDefaults,
  libraryImportKey as keyOf,
  libraryImportButtonLabel,
  libraryImportSelection,
  libraryReplaceWarning,
} from "@t3tools/client-runtime/state/library";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import type {
  EnvironmentId,
  LibraryImportable,
  LibraryImportableItem,
  PeerLinkSummary,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { T, useGT, useMessages, Var } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { offersLinkedEnvironmentsAtom, peerLinkEnvironment } from "../../state/peerLinks";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { LinkEnvironmentAction } from "../settings/LinkedEnvironmentsSettings";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

type Listing =
  | { readonly key: string; readonly status: "checking" }
  | { readonly key: string; readonly status: "ready"; readonly listed: LibraryImportable }
  | { readonly key: string; readonly status: "failed"; readonly message: string };

/**
 * Imports workflows and roles from one of this machine's linked machines: pick the machine, then
 * tick what to bring. A workflow brings the roles it needs that this machine lacks.
 */
export function LibraryImportDialog({
  environmentId,
  environmentLabel,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [running, setRunning] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && running) return;
        onOpenChange(next);
      }}
    >
      <DialogPopup showCloseButton={!running} className="max-w-xl">
        {open ? (
          <ImportForm
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            running={running}
            setRunning={setRunning}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ImportForm({
  environmentId,
  environmentLabel,
  running,
  setRunning,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly running: boolean;
  readonly setRunning: (running: boolean) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const offered = useAtomValue(offersLinkedEnvironmentsAtom(environmentId));
  const links = useEnvironmentQuery(
    offered ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  const importable = useAtomCommand(rolesEnvironment.importable, { reportFailure: false });
  const importItems = useAtomCommand(rolesEnvironment.importItems, { reportFailure: false });
  const nowMinute = useNowMinute();
  const [picked, setPicked] = useState<EnvironmentId | null>(null);
  // Machines found too old to import from, until the dialog closes.
  const [older, setOlder] = useState<ReadonlySet<EnvironmentId>>(new Set());
  const [listing, setListing] = useState<Listing | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);

  const list = links.data?.links ?? null;
  const reasonOf = (link: PeerLinkSummary) => {
    if (older.has(link.environmentId)) {
      return gt("Update Bosun on {machine} to import from it", { machine: link.label });
    }
    const health = peerLinkHealth(link, DateTime.makeUnsafe(nowMinute));
    if (health.kind === "expired") return gt("Expired. Link it again.");
    // The link's own reason is the server's English; the person reads this one.
    if (health.kind === "unreachable" || health.kind === "failing") {
      return gt("Not answering right now");
    }
    if (link.access !== "full-access") {
      return gt("Needs full access. Link {machine} again with full access.", {
        machine: link.label,
      });
    }
    return null;
  };
  const usable = (list ?? []).filter((link) => reasonOf(link) === null);
  const source =
    picked !== null && usable.some((link) => link.environmentId === picked)
      ? picked
      : usable.length === 1
        ? usable[0]!.environmentId
        : null;
  const sourceLabel = list?.find((link) => link.environmentId === source)?.label ?? null;
  const key = source === null ? null : `${source}:${attempt}`;
  const current: Listing | null =
    key === null
      ? null
      : listing !== null && listing.key === key
        ? listing
        : { key, status: "checking" };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the picked machine what it has; the answer for an older pick is dropped.
  useEffect(() => {
    if (key === null || source === null) return;
    let live = true;
    void importable({ environmentId, input: { sourceEnvironmentId: source } }).then((result) => {
      if (!live) return;
      if (result._tag !== "Success") {
        setListing({ key, status: "failed", message: formatEnvironmentQueryError(result.cause) });
        return;
      }
      if (result.value.problem === "outdated") {
        setOlder((known) => new Set(known).add(source));
      }
      setTicked(libraryImportDefaults(result.value.items));
      setListing({ key, status: "ready", listed: result.value });
    });
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The key names the machine and attempt; the command function is new each render.
  }, [key]);

  const listed = current?.status === "ready" ? current.listed : null;
  const items = listed?.items ?? [];
  const workflows = items.filter((item) => item.kind === "workflow");
  const roles = items.filter((item) => item.kind === "role");
  const { neededBy, chosen, replacing } = libraryImportSelection(items, ticked);

  const submit = async () => {
    if (source === null || chosen.length === 0) return;
    setRunning(true);
    setFailure(null);
    const result = await importItems({
      environmentId,
      input: {
        sourceEnvironmentId: source,
        roleIds: chosen.filter((item) => item.kind === "role").map((item) => item.id),
        workflowIds: chosen.filter((item) => item.kind === "workflow").map((item) => item.id),
        replace: replacing.length > 0,
      },
    });
    setRunning(false);
    if (result._tag !== "Success") {
      setFailure(formatEnvironmentQueryError(result.cause));
      return;
    }
    toastManager.add({
      type: "success",
      title: gt(
        "{count, plural, one {Imported {count} item from {machine}} other {Imported {count} items from {machine}}}",
        { count: result.value.imported.length, machine: sourceLabel ?? "" },
      ),
    });
    onClose();
  };

  const toggle = (item: LibraryImportableItem, next: boolean) =>
    setTicked((currentTicked) => {
      const updated = new Set(currentTicked);
      if (next) updated.add(keyOf(item));
      else updated.delete(keyOf(item));
      return updated;
    });

  /** A workflow's crew, naming the roles it would use that this machine already has. */
  const crewDetail = (workflow: LibraryImportableItem) => {
    const count = workflow.crewRoleIds.length;
    const ours = roles
      .filter((role) => workflow.crewRoleIds.includes(role.id) && role.status !== "new")
      .filter((role) => !chosen.some((item) => item.kind === "role" && item.id === role.id))
      .map((role) => role.replaces?.name ?? role.name);
    return ours.length === 0
      ? gt("{count, plural, one {{count} crew role} other {{count} crew roles}}", { count })
      : gt(
          "{count, plural, one {{count} crew role · uses your {names}} other {{count} crew roles · uses your {names}}}",
          { count, names: ours.join(", ") },
        );
  };
  const itemRow = (item: LibraryImportableItem) => {
    const locked = item.kind === "role" && neededBy.has(item.id) && !ticked.has(keyOf(item));
    const checked = item.status === "current" || ticked.has(keyOf(item)) || locked;
    const detail =
      item.status === "current"
        ? gt("Already up to date")
        : locked
          ? gt("Needed by {workflow}", { workflow: neededBy.get(item.id) ?? "" })
          : item.kind === "workflow"
            ? crewDetail(item)
            : item.status === "new"
              ? gt("Not on {machine}", { machine: environmentLabel })
              : null;
    const replaces = item.replaces;
    const note =
      item.status === "update" ? (
        <Badge variant="info" size="sm">
          <T>Update available</T>
        </Badge>
      ) : replaces === null ? null : replaces.importedFrom !== null ? (
        <span className="text-xs text-warning-foreground">
          {gt("Replaces your {name} from {machine}", {
            name: replaces.name,
            machine: replaces.importedFrom,
          })}
        </span>
      ) : replaces.stock ? (
        <span className="text-xs text-muted-foreground">
          {gt("Replaces the starter {name}", { name: replaces.name })}
        </span>
      ) : (
        <span className="text-xs text-warning-foreground">
          {gt("Replaces your {name}", { name: replaces.name })}
        </span>
      );
    const disabled = item.status === "current" || locked;
    return (
      <li key={keyOf(item)}>
        <label
          className={cn(
            "flex items-center gap-3 px-3 py-2.5",
            disabled ? "cursor-default" : "cursor-pointer",
          )}
        >
          <Checkbox
            checked={checked}
            disabled={disabled}
            onCheckedChange={(next) => toggle(item, next === true)}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{item.name}</span>
            {detail === null ? null : (
              <span className="truncate text-xs text-muted-foreground">{detail}</span>
            )}
          </span>
          {note === null ? null : <span className="shrink-0 text-right">{note}</span>}
        </label>
      </li>
    );
  };
  const section = (title: string, sectionItems: ReadonlyArray<LibraryImportableItem>) =>
    sectionItems.length === 0 ? null : (
      <div className="space-y-2">
        <Label>{title}</Label>
        <ul className="divide-y divide-border rounded-lg border bg-card">
          {sectionItems.map(itemRow)}
        </ul>
      </div>
    );
  const nothingNew =
    listed !== null && listed.problem === null && items.every((item) => item.status === "current");

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {sourceLabel === null
            ? gt("Import from…")
            : gt("Import from {machine}", { machine: sourceLabel })}
        </DialogTitle>
        <DialogDescription>
          {gt(
            "Into {machine}. You can edit what you import. When the original changes, it shows Update available.",
            { machine: environmentLabel },
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <fieldset disabled={running} className="min-w-0 space-y-5">
          {!offered ? (
            <div className="rounded-lg border border-dashed">
              <Empty size="compact">
                <EmptyHeader>
                  <EmptyTitle>
                    <T>
                      Linked environments are off on <Var>{environmentLabel}</Var>
                    </T>
                  </EmptyTitle>
                  <EmptyDescription>
                    <T>
                      Turn them on in{" "}
                      <Link to="/settings/labs" className="underline underline-offset-2">
                        Settings → Labs
                      </Link>
                      .
                    </T>
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : links.error ? (
            <p className="text-xs text-destructive" role="status">
              <T>
                Could not load linked machines: <Var>{links.error}</Var>
              </T>
            </p>
          ) : list === null ? (
            <p className="text-xs text-muted-foreground" role="status">
              <T>Loading linked machines…</T>
            </p>
          ) : list.length === 0 ? (
            <div className="space-y-2">
              <div className="rounded-lg border border-dashed">
                <Empty size="compact">
                  <EmptyHeader>
                    <EmptyTitle>
                      <T>No linked machines</T>
                    </EmptyTitle>
                    <EmptyDescription>
                      <T>Link another machine running Bosun first.</T>
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
              {canLink ? (
                <div className="flex justify-end">
                  <LinkEnvironmentAction
                    environmentId={environmentId}
                    label={gt("Link a machine")}
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label id="library-import-source">
                  <T>From</T>
                </Label>
                <RadioGroup
                  value={source ?? ""}
                  onValueChange={(next) => {
                    setPicked(next as EnvironmentId);
                    setFailure(null);
                  }}
                  aria-labelledby="library-import-source"
                >
                  <ul className="divide-y divide-border rounded-lg border bg-card">
                    {list.map((link) => (
                      <SourceRow key={link.environmentId} link={link} reason={reasonOf(link)} />
                    ))}
                  </ul>
                </RadioGroup>
                {canLink ? (
                  <div className="flex justify-end">
                    <LinkEnvironmentAction
                      environmentId={environmentId}
                      label={gt("Link another machine")}
                    />
                  </div>
                ) : null}
              </div>
              {current?.status === "checking" ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                  <Spinner size="xs" />
                  {gt("Checking {machine}…", { machine: sourceLabel ?? "" })}
                </p>
              ) : current?.status === "failed" ? (
                <Alert variant="error">
                  <TriangleAlertIcon />
                  <AlertDescription>{current.message}</AlertDescription>
                  <AlertAction>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setAttempt((count) => count + 1)}
                    >
                      <T>Try again</T>
                    </Button>
                  </AlertAction>
                </Alert>
              ) : listed !== null && listed.problem !== null ? (
                <Alert variant="warning">
                  <TriangleAlertIcon />
                  <AlertDescription>
                    {listed.problem === "outdated"
                      ? gt("Update Bosun on {machine} to import from it.", {
                          machine: listed.source.label,
                        })
                      : listed.problem === "denied"
                        ? gt("Importing from {machine} needs a full-access link.", {
                            machine: listed.source.label,
                          })
                        : gt("{machine} didn't answer. Try again when it's on.", {
                            machine: listed.source.label,
                          })}
                  </AlertDescription>
                  {listed.problem === "outdated" ? null : (
                    <AlertAction>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setAttempt((count) => count + 1)}
                      >
                        <T>Try again</T>
                      </Button>
                    </AlertAction>
                  )}
                </Alert>
              ) : nothingNew ? (
                <div className="rounded-lg border border-dashed">
                  <Empty size="compact">
                    <EmptyHeader>
                      <EmptyTitle>
                        {gt("Nothing new on {machine}", { machine: listed.source.label })}
                      </EmptyTitle>
                      <EmptyDescription>
                        <T>
                          You already have every workflow and role it has, at its latest version.
                        </T>
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </div>
              ) : listed !== null ? (
                <>
                  {section(
                    gt("Workflows on {machine} · {count}", {
                      count: workflows.length,
                      machine: listed.source.label,
                    }),
                    workflows,
                  )}
                  {section(
                    gt("Roles on {machine} · {count}", {
                      count: roles.length,
                      machine: listed.source.label,
                    }),
                    roles,
                  )}
                </>
              ) : null}
              {replacing.length > 0 ? (
                <Alert variant="warning">
                  <TriangleAlertIcon />
                  <AlertDescription>
                    {libraryReplaceWarning(replacing, environmentLabel, m)}
                  </AlertDescription>
                </Alert>
              ) : null}
              {failure === null ? null : (
                <Alert variant="error">
                  <TriangleAlertIcon />
                  <AlertTitle>
                    <T>Couldn't import</T>
                  </AlertTitle>
                  <AlertDescription>{failure}</AlertDescription>
                </Alert>
              )}
            </>
          )}
        </fieldset>
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" disabled={running} onClick={onClose}>
          <T>Cancel</T>
        </Button>
        <Button disabled={running || chosen.length === 0} onClick={() => void submit()}>
          {running ? <Spinner size="xs" /> : null}
          {running
            ? gt("Importing…")
            : replacing.length > 0
              ? gt("Import and replace")
              : chosen.length === 0
                ? gt("Import")
                : libraryImportButtonLabel(chosen, m)}
        </Button>
      </DialogFooter>
    </>
  );
}

function SourceRow({
  link,
  reason,
}: {
  readonly link: PeerLinkSummary;
  readonly reason: string | null;
}) {
  const nowMinute = useNowMinute();
  const health = peerLinkHealth(link, DateTime.makeUnsafe(nowMinute));
  return (
    <li>
      <label
        className={cn(
          "flex items-center gap-3 px-3 py-2.5",
          reason === null ? "cursor-pointer" : "cursor-not-allowed",
        )}
      >
        <Radio value={link.environmentId} disabled={reason !== null} />
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            health.kind === "reachable"
              ? "bg-success"
              : health.kind === "expired" || health.kind === "failing"
                ? "bg-destructive"
                : "bg-muted-foreground/30",
          )}
        />
        <span
          className={cn(
            "max-w-[45%] shrink-0 truncate text-sm font-medium",
            reason !== null && "text-muted-foreground",
          )}
        >
          {link.label}
        </span>
        <span className="min-w-0 flex-1 text-right text-xs text-muted-foreground">
          {reason ?? <T>Reachable</T>}
        </span>
      </label>
    </li>
  );
}
