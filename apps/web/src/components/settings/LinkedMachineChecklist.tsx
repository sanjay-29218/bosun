import { useAtomValue } from "@effect/atom-react";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import type { EnvironmentId, PeerLinkSummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { offersLinkedEnvironmentsAtom, peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Label } from "../ui/label";
import { LinkEnvironmentAction } from "./LinkedEnvironmentsSettings";

/**
 * Every machine linked to `environmentId`, each with a tick, whether it answers, and an optional
 * note, for an agent's Can work on list. Several can be ticked.
 */
export function LinkedMachineChecklist({
  environmentId,
  homeLabel,
  description,
  emptyDescription,
  checked,
  disabled,
  noteFor,
  onToggle,
}: {
  readonly environmentId: EnvironmentId;
  readonly homeLabel: string;
  readonly description: string;
  readonly emptyDescription: string;
  readonly checked: ReadonlyArray<EnvironmentId>;
  readonly disabled: boolean;
  readonly noteFor?: (environmentId: EnvironmentId) => string | null;
  readonly onToggle: (environmentId: EnvironmentId, checked: boolean) => void;
}) {
  const offered = useAtomValue(offersLinkedEnvironmentsAtom(environmentId));
  const links = useEnvironmentQuery(
    offered ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));

  if (!offered) {
    return (
      <section className="space-y-2" aria-label="Can work on">
        <Label>Can work on</Label>
        <p className="text-xs text-muted-foreground">
          Linked environments are off on {homeLabel}. Turn them on in{" "}
          <Link to="/settings/labs" className="underline underline-offset-2">
            Settings → Labs
          </Link>
          .
        </p>
      </section>
    );
  }

  const list = links.data?.links ?? null;
  return (
    <section className="space-y-2" aria-label="Can work on">
      <div className="flex items-center justify-between gap-2">
        <Label>Can work on</Label>
        {canLink ? (
          <LinkEnvironmentAction environmentId={environmentId} label="Link an environment" />
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      {links.error ? (
        <p className="text-xs text-destructive" role="status">
          Could not load linked machines: {links.error}
        </p>
      ) : list === null ? (
        <p className="text-xs text-muted-foreground" role="status">
          Loading linked machines…
        </p>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-dashed">
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>No linked machines</EmptyTitle>
              <EmptyDescription>{emptyDescription}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-lg border bg-card">
            {list.map((link) => (
              <MachineRow
                key={link.environmentId}
                link={link}
                checked={checked.includes(link.environmentId)}
                disabled={disabled}
                note={noteFor?.(link.environmentId) ?? null}
                onChange={(next) => onToggle(link.environmentId, next)}
              />
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Unticking stops new work there. Work already running keeps going.
          </p>
        </>
      )}
    </section>
  );
}

function MachineRow({
  link,
  checked,
  disabled,
  note,
  onChange,
}: {
  readonly link: PeerLinkSummary;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly note: string | null;
  readonly onChange: (checked: boolean) => void;
}) {
  const nowMinute = useNowMinute();
  const health = peerLinkHealth(link, DateTime.makeUnsafe(nowMinute));
  const status =
    health.kind === "expired"
      ? "Expired. Link it again."
      : health.kind === "unreachable"
        ? (health.detail ?? "Not answering right now")
        : health.kind === "failing"
          ? health.detail
          : health.expiresInDays !== null
            ? `Expires in ${health.expiresInDays} ${health.expiresInDays === 1 ? "day" : "days"}`
            : "Online";
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onChange(next === true)}
        />
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            health.kind === "reachable"
              ? health.expiresInDays === null
                ? "bg-success"
                : "bg-warning"
              : health.kind === "expired" || health.kind === "failing"
                ? "bg-destructive"
                : "bg-muted-foreground/30",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{link.label}</span>
          {note === null ? null : (
            <span className="block truncate text-xs text-muted-foreground">{note}</span>
          )}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
      </label>
    </li>
  );
}
