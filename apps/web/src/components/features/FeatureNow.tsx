import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  WORK_ROW_LABELS,
  featureCardKey,
  featureFinished,
  featureRef,
  type EnvironmentFeatureCard,
  type WorkRowStatus,
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
import { RelativeTime, WorkingDuration } from "./FeatureCard";
import { parentNow } from "./featureNow.logic";
import { WorkIcon, featureWork } from "./workStatus";

type Threads = (card: EnvironmentFeatureCard) => ReadonlyArray<EnvironmentThreadShell>;

const TONE_SURFACE = {
  working: "bg-info/8 text-info-foreground",
  waiting: "bg-warning/10 text-warning-foreground",
  quiet: "bg-muted/40 text-muted-foreground",
} as const;

/** Who a thread runs as: its crew member, else the feature's lead. */
const crewName = (thread: EnvironmentThreadShell | null) => thread?.feature?.member ?? "Lead";

/** What a thread waiting on the person wants: an approval, else an answer. */
const askLabel = (thread: EnvironmentThreadShell, who: string) =>
  thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval"
    ? `Needs input: ${who} asks for your approval`
    : `Needs input: ${who} asks a question`;

/** A lead that stopped short of finishing the feature. */
const STOPPED = "Waiting: the lead stopped before finishing";

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
  readonly icon: WorkRowStatus;
  readonly label: string;
  readonly since?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className={cn("-mx-1 rounded-md px-2 py-1.5", TONE_SURFACE[props.tone])}>
      <div className="flex min-w-0 items-center gap-1.5 font-medium">
        <WorkIcon status={props.icon} className="size-3.5" />
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
  const { status, thread } = featureWork(card, props.threads);
  // A lead waiting because one of its crew asks names that member.
  const asker =
    thread && thread.feature?.member === undefined && thread.pendingSubagentRequest
      ? roster.find((entry) => entry.tone === "needs-input")?.name
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
  switch (status) {
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
    case "needs-input":
      return (
        <NowLine
          tone="waiting"
          icon="needs-input"
          label={thread ? askLabel(thread, who) : WORK_ROW_LABELS["needs-input"]}
          since={waitedSince(thread)}
        >
          {chain}
        </NowLine>
      );
    case "waiting":
    case "failed":
    case "review":
    case "done":
      return (
        <NowLine tone="quiet" icon={status} label={settledLabel(card, props.threads, status)}>
          {chain}
        </NowLine>
      );
    case "not-started":
      return <NowLine tone="quiet" icon="not-started" label={WORK_ROW_LABELS["not-started"]} />;
  }
}

/** What a feature that isn't running or asking says about where it stopped. */
function settledLabel(
  card: EnvironmentFeatureCard,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  status: "waiting" | "failed" | "review" | "done",
) {
  switch (status) {
    case "waiting":
      return STOPPED;
    case "failed":
      return "Failed: the lead's turn failed";
    case "review":
      return featureFinished(card, threads)
        ? "Ready for review: the lead reported it finished"
        : WORK_ROW_LABELS.review;
    case "done":
      return "Done: its pull request merged";
  }
}

function ParentNow(props: {
  readonly card: EnvironmentFeatureCard;
  readonly cards: ReadonlyArray<EnvironmentFeatureCard>;
  readonly threadsFor: Threads;
}) {
  // The parent's own threads, without the children's the board merges in.
  const ownThreads = props
    .threadsFor(props.card)
    .filter((thread) => thread.feature?.id === props.card.featureId);
  const own = featureWork(props.card, ownThreads);
  const rows = props.cards.map((card) => ({
    card,
    ...featureWork(card, props.threadsFor(card)),
  }));
  const now = parentNow(
    { status: own.status, asks: own.status === "needs-input" && own.thread !== null },
    rows.map((row) => row.status),
  );
  const summary = [
    now.needYou > 0 ? `${now.needYou} need${now.needYou === 1 ? "s" : ""} input` : null,
    now.working > 0 ? `${now.working} working` : null,
    now.review > 0 ? `${now.review} ready for review` : null,
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
      icon: "needs-input",
      label: own.thread ? askLabel(own.thread, ownWho) : WORK_ROW_LABELS["needs-input"],
      since: waitedSince(own.thread),
    },
    "children-need-you": { tone: "waiting", icon: "needs-input", label: summary, since: null },
    "own-working": {
      tone: "working",
      icon: "working",
      label: `${ownWho} is working`,
      since: ownStartedAt ? <WorkingDuration startedAt={ownStartedAt} /> : null,
    },
    "children-working": { tone: "working", icon: "working", label: summary, since: null },
    "own-turn": {
      tone: "quiet",
      icon: own.status === "failed" || own.status === "review" ? own.status : "waiting",
      label:
        own.status === "failed" || own.status === "review"
          ? settledLabel(props.card, ownThreads, own.status)
          : STOPPED,
      since: null,
    },
    settled: {
      tone: "quiet",
      icon: now.done === now.total ? "done" : "waiting",
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
        {rows.map(({ card, status: rowStatus, look: status, thread }) => {
          const StatusIcon = status.icon;
          const startedAt =
            rowStatus === "working" && thread ? resolveThreadWorkingStartedAt(thread) : null;
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
                ) : rowStatus === "done" || rowStatus === "not-started" ? null : (
                  status.label
                )}
              </span>
            </div>
          );
        })}
      </div>
    </NowLine>
  );
}
