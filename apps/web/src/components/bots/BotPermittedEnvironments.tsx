import { useAtomValue } from "@effect/atom-react";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import type { Bot, EnvironmentId, PeerLinkSummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { offersLinkedEnvironmentsAtom, peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { LinkEnvironmentAction } from "../settings/LinkedEnvironmentsSettings";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Label } from "../ui/label";

/**
 * The linked machines a bot may start work on, ticked on its home. A tick saves at once; ids no
 * longer linked stay saved untouched and aren't shown.
 */
export function BotPermittedEnvironments({
  environmentId,
  homeLabel,
  bot,
  canEdit,
  onSave,
}: {
  readonly environmentId: EnvironmentId;
  readonly homeLabel: string;
  readonly bot: Bot;
  readonly canEdit: boolean;
  readonly onSave: (permittedEnvironmentIds: ReadonlyArray<EnvironmentId>) => Promise<boolean>;
}) {
  const offered = useAtomValue(offersLinkedEnvironmentsAtom(environmentId));
  const links = useEnvironmentQuery(
    offered ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  const [saving, setSaving] = useState(false);

  const toggle = async (linkedId: EnvironmentId, permitted: boolean) => {
    setSaving(true);
    await onSave(
      permitted
        ? [...bot.permittedEnvironmentIds, linkedId]
        : bot.permittedEnvironmentIds.filter((id) => id !== linkedId),
    );
    setSaving(false);
  };

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
      <p className="text-xs text-muted-foreground">
        {homeLabel}'s linked machines this bot may start work on.
      </p>
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
              <EmptyDescription>
                Link another machine running Bosun, such as a VPS, so {bot.name} can work there.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-lg border bg-card">
            {list.map((link) => (
              <PermittedRow
                key={link.environmentId}
                link={link}
                checked={bot.permittedEnvironmentIds.includes(link.environmentId)}
                disabled={saving || !canEdit}
                onChange={(checked) => void toggle(link.environmentId, checked)}
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

function PermittedRow({
  link,
  checked,
  disabled,
  onChange,
}: {
  readonly link: PeerLinkSummary;
  readonly checked: boolean;
  readonly disabled: boolean;
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
            : "Reachable";
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
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{link.label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
      </label>
    </li>
  );
}
