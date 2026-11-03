import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  featureCardKey,
  featureFinished,
  featureRef,
  threadNeedsYouKind,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";
import { buildCrewRoster } from "@t3tools/client-runtime/state/crew-roster";
import {
  resolveThreadWorkingStartedAt,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { ArrowRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useWorkGroup } from "../../state/workGroup";
import { CrewRosterIcon } from "../crew/CrewRosterIcon";
import { RelativeTime, WorkingDuration, featureStatus } from "./FeatureCard";
import { parentNow } from "./featureNow.logic";

type Threads = (card: EnvironmentFeatureCard) => ReadonlyArray<EnvironmentThreadShell>;

const TONE_SURFACE = {
  working: "bg-info/8 text-info-foreground",
  waiting: "bg-warning/10 text-warning-foreground",
  quiet: "bg-muted/40 text-muted-foreground",
} as const;

/** Who a thread runs as: its crew member, else the feature's lead. */
const crewName = (thread: EnvironmentThreadShell | null) => thread?.feature?.member ?? "Lead";

/** What a thread waiting on the person wants; with none asking, the lead stopped. */
const askLabel = (thread: EnvironmentThreadShell | null, who: string) =>
  thread?.hasPendingApprovals || thread?.pendingSubagentRequest === "approval"
    ? `${who} needs your approval`
    : (thread && threadNeedsYouKind(thread) === "question") || thread?.pendingSubagentRequest
      ? `${who} needs your answer`
      : "Your turn: the lead stopped";

const waitedSince = (thread: EnvironmentThreadShell | null) =>
  thread ? <RelativeTime timestamp={thread.runtime?.updatedAt ?? thread.updatedAt} /> : null;

/**
 * Where a feature stands right now, for its hover card: the most urgent thing, who, and for how
 * long, then its crew in order. A parent sums up its children instead. Mounted only while the
 * card is open.
 */
export function FeatureNow(props: {
  readonly card: EnvironmentFeatureCard;
  readonly threadsFor: Threads;
  readonly childCards?: ReadonlyArray<EnvironmentFeatureCard>;
}) {
  const children = props.childCards ?? [];
  return children.length > 0 ? (
    <ParentNow card={props.card} cards={children} threadsFor={props.threadsFor} />
  ) : (
    <FeatureCrewNow card={props.card} threads={props.threadsFor(props.card)} />
  );
}

function NowLine(props: {
  readonly tone: keyof typeof TONE_SURFACE;
  readonly icon: "working" | "waiting" | "done" | "idle";
  readonly label: string;
  readonly since?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className={cn("-mx-1 rounded-md px-2 py-1.5", TONE_SURFACE[props.tone])}>
      <div className="flex min-w-0 items-center gap-1.5 font-medium">
        <CrewRosterIcon tone={props.icon} />
        <span className="min-w-0 truncate">{props.label}</span>
        {props.since ? (
          <span className="ms-auto shrink-0 font-normal opacity-80">{props.since}</span>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}

function FeatureCrewNow(props: {
  readonly card: EnvironmentFeatureCard;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const { card } = props;
  const group = useWorkGroup(
    card.leadThreadId ? scopeThreadRef(card.environmentId, card.leadThreadId) : null,
  );
  const roster = group ? buildCrewRoster(group).filter((entry) => entry.kind === "member") : [];
  const { column, status, thread } = featureStatus(card, props.threads);
  // A lead waiting because one of its crew asks names that member.
  const asker =
    thread && thread.feature?.member === undefined && thread.pendingSubagentRequest
      ? roster.find((entry) => entry.tone === "waiting")?.name
      : undefined;
  const who = asker ?? crewName(thread);
  const chain =
    roster.length > 0 ? (
      <div className="mt-1 flex flex-wrap items-center gap-1 text-2xs">
        {roster.map((entry, index) => (
          <span key={entry.key} className="inline-flex items-center gap-1">
            {index > 0 ? <ArrowRightIcon aria-hidden className="size-2.5 opacity-40" /> : null}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-foreground/80",
                entry.threadId === thread?.id || entry.name === asker
                  ? "border-current"
                  : "border-border/70",
              )}
            >
              <CrewRosterIcon tone={entry.tone} />
              {entry.name}
            </span>
          </span>
        ))}
      </div>
    ) : null;
  switch (column) {
    case "working": {
      const startedAt = thread ? resolveThreadWorkingStartedAt(thread) : null;
      return (
        <NowLine
          tone="working"
          icon="working"
          label={`${who} is working`}
          since={startedAt ? <WorkingDuration startedAt={startedAt} /> : null}
        >
          {chain}
        </NowLine>
      );
    }
    case "needs-you":
      return thread === null && featureFinished(card, props.threads) ? (
        <NowLine tone="quiet" icon="done" label="Ready for review: the lead reported it done">
          {chain}
        </NowLine>
      ) : (
        <NowLine
          tone="waiting"
          icon="waiting"
          label={askLabel(thread, who)}
          since={waitedSince(thread)}
        >
          {chain}
        </NowLine>
      );
    case "done":
      return (
        <NowLine tone="quiet" icon="done" label={status.label}>
          {chain}
        </NowLine>
      );
    case "todo":
      return <NowLine tone="quiet" icon="idle" label={status.label} />;
  }
}

function ParentNow(props: {
  readonly card: EnvironmentFeatureCard;
  readonly cards: ReadonlyArray<EnvironmentFeatureCard>;
  readonly threadsFor: Threads;
}) {
  // The parent's own threads, without the children's the board merges in.
  const own = featureStatus(
    props.card,
    props.threadsFor(props.card).filter((thread) => thread.feature?.id === props.card.featureId),
  );
  const rows = props.cards.map((card) => ({
    card,
    ...featureStatus(card, props.threadsFor(card)),
  }));
  const now = parentNow(
    { column: own.column, asks: own.column === "needs-you" && own.thread !== null },
    rows.map((row) => row.column),
  );
  const summary = [
    now.needYou > 0 ? `${now.needYou} need${now.needYou === 1 ? "s" : ""} you` : null,
    now.working > 0 ? `${now.working} working` : null,
    `${now.done} of ${now.total} done`,
  ]
    .filter(Boolean)
    .join(" · ");
  const ownWho = crewName(own.thread);
  const ownStartedAt =
    now.headline === "own-working" && own.thread ? resolveThreadWorkingStartedAt(own.thread) : null;
  const head = {
    "own-asks": {
      tone: "waiting",
      icon: "waiting",
      label: askLabel(own.thread, ownWho),
      since: waitedSince(own.thread),
    },
    "children-need-you": { tone: "waiting", icon: "waiting", label: summary, since: null },
    "own-working": {
      tone: "working",
      icon: "working",
      label: `${ownWho} is working`,
      since: ownStartedAt ? <WorkingDuration startedAt={ownStartedAt} /> : null,
    },
    "children-working": { tone: "working", icon: "working", label: summary, since: null },
    "own-turn": featureFinished(
      props.card,
      props.threadsFor(props.card).filter((thread) => thread.feature?.id === props.card.featureId),
    )
      ? { tone: "quiet", icon: "done", label: "Ready for review", since: null }
      : { tone: "waiting", icon: "waiting", label: askLabel(null, ownWho), since: null },
    settled: {
      tone: "quiet",
      icon: now.done === now.total ? "done" : "idle",
      label: summary,
      since: null,
    },
  } as const satisfies Record<string, Parameters<typeof NowLine>[0]>;
  const lead = head[now.headline];
  const ownHeadline = lead.label !== summary;
  return (
    <NowLine tone={lead.tone} icon={lead.icon} label={lead.label} since={lead.since}>
      {ownHeadline ? <div className="mt-0.5 text-2xs opacity-80">{summary}</div> : null}
      <div className="mt-1 grid gap-0.5 text-2xs text-foreground/80">
        {rows.map(({ card, column, status, thread }) => {
          const StatusIcon = status.icon;
          const startedAt =
            column === "working" && thread ? resolveThreadWorkingStartedAt(thread) : null;
          return (
            <div key={featureCardKey(card)} className="flex min-w-0 items-center gap-1.5">
              <StatusIcon aria-hidden className={cn("size-3 shrink-0", status.className)} />
              <span className="shrink-0 tabular-nums opacity-60">{featureRef(card)}</span>
              <span className="min-w-0 truncate">{card.title}</span>
              <span className={cn("ms-auto shrink-0", status.className)}>
                {startedAt ? (
                  <>
                    {crewName(thread)} · <WorkingDuration startedAt={startedAt} />
                  </>
                ) : column === "needs-you" ? (
                  status.label
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </NowLine>
  );
}
