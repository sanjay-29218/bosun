import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  featureCardKey,
  featureFinished,
  featureRef,
  threadNeedsYouKind,
  threadsByFeature,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";
import { buildCrewRoster, type CrewRosterEntry } from "@t3tools/client-runtime/state/crew-roster";
import { workGroupLead, type WorkGroup } from "@t3tools/client-runtime/state/work-groups";
import {
  resolveThreadWorkingStartedAt,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CornerLeftUpIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useQuietThreadShells, useThreadShell } from "../../state/entities";
import { useWorkGroup } from "../../state/workGroup";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { WorkingDuration, featureStatus } from "../features/FeatureCard";
import { useFeatureBoard } from "../features/useFeatureBoard";
import { CrewRosterHereMark, CrewRosterIcon, CrewRosterStatus } from "./CrewRosterIcon";

/**
 * A feature's or bot request's crew in the thread details panel, below the workspace: who leads,
 * who it handed work to and where each stands, then the feature it's part of and its own child
 * features. The heading says what needs the person, else what runs.
 */
export function ThreadCrewSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useThreadShell(ref);
  const group = useWorkGroup(thread?.feature || thread?.crewRequest ? ref : null);
  if (!thread || !group) return null;
  return <CrewSection thread={thread} group={group} />;
}

function CrewSection(props: {
  readonly thread: EnvironmentThreadShell;
  readonly group: WorkGroup<EnvironmentThreadShell>;
}) {
  const { thread } = props;
  const navigate = useNavigate();
  const feature = thread.feature;
  // Only a feature has a parent or children; its project's board cards carry the links.
  const board = useFeatureBoard(
    feature ? [{ environmentId: thread.environmentId, projectId: thread.projectId }] : [],
  );
  const shells = useQuietThreadShells();
  const roster = buildCrewRoster(props.group);
  const own = feature ? board.cards.find((card) => card.featureId === feature.id) : undefined;
  const parent = own?.parentFeatureId
    ? board.cards.find((card) => card.featureId === own.parentFeatureId)
    : undefined;
  const threads = threadsByFeature(shells);
  const finished = own ? featureFinished(own, threads.get(featureCardKey(own)) ?? []) : false;
  const children = (
    feature ? board.cards.filter((card) => card.parentFeatureId === feature.id) : []
  )
    .toSorted((a, b) => (a.number ?? 0) - (b.number ?? 0) || a.createdAt.localeCompare(b.createdAt))
    .map((card) => ({ card, ...featureStatus(card, threads.get(featureCardKey(card)) ?? []) }));

  // A member's question also shows on its lead, so the lead counts only for its own.
  const lead = workGroupLead(props.group);
  const asking =
    roster.filter(
      (entry) =>
        entry.kind === "member" && (entry.status === "Approval" || entry.status === "Input"),
    ).length +
    (lead && threadNeedsYouKind(lead) !== null ? 1 : 0) +
    children.filter((child) => child.column === "needs-you" && child.thread !== null).length;
  const running =
    roster.filter((entry) => entry.tone === "working").length +
    children.filter((child) => child.column === "working").length;
  const title =
    asking > 0
      ? `Crew · ${asking} need${asking === 1 ? "s" : ""} you`
      : running > 0
        ? `Crew · ${running} running`
        : "Crew";
  const done = children.filter((child) => child.column === "done").length;
  const label = (card: EnvironmentFeatureCard) =>
    [featureRef(card), card.title].filter(Boolean).join(" ");
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, threadId)),
    });

  return (
    <ThreadDetailsSection headingId="thread-details-crew-heading" title={title}>
      <div className="flex flex-col">
        {roster.map((entry) => (
          <CrewRow
            key={entry.key}
            entry={
              // A lead that reported its feature finished isn't waiting on the person.
              entry.kind === "lead" && entry.status === "Your turn" && finished
                ? {
                    ...entry,
                    status: own?.parentFeatureId ? "Done" : "Ready for review",
                    tone: "done",
                  }
                : entry
            }
            environmentId={thread.environmentId}
            here={entry.threadId === thread.id}
            onOpen={() => openThread(entry.threadId)}
          />
        ))}
        {parent ? (
          <ThreadDetailsControl
            part="row"
            aria-label={`Part of ${label(parent)}, open its lead`}
            disabled={parent.leadThreadId === null}
            onClick={() => parent.leadThreadId && openThread(parent.leadThreadId)}
          >
            <CornerLeftUpIcon className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-start">
              <span className="text-muted-foreground">Part of </span>
              {label(parent)}
            </span>
          </ThreadDetailsControl>
        ) : null}
        {children.length > 0 ? (
          <div className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">
            Child features · {done} of {children.length} done
          </div>
        ) : null}
        {children.map(({ card, column, status, thread: statusThread }) => {
          const StatusIcon = status.icon;
          const startedAt =
            column === "working" && statusThread
              ? resolveThreadWorkingStartedAt(statusThread)
              : null;
          return (
            <ThreadDetailsControl
              key={featureCardKey(card)}
              part="row"
              disabled={card.leadThreadId === null}
              onClick={() => card.leadThreadId && openThread(card.leadThreadId)}
            >
              <StatusIcon aria-hidden className={cn("size-3.5 shrink-0", status.className)} />
              <span className="min-w-0 flex-1 truncate text-start">{label(card)}</span>
              <span className={cn("shrink-0 text-xs tabular-nums", status.className)}>
                {startedAt ? (
                  <>
                    {statusThread?.feature?.member ?? "Lead"} ·{" "}
                    <WorkingDuration startedAt={startedAt} />
                  </>
                ) : (
                  status.label
                )}
              </span>
            </ThreadDetailsControl>
          );
        })}
      </div>
    </ThreadDetailsSection>
  );
}

/** One of the crew, with how long it has run when it's working. */
function CrewRow(props: {
  readonly entry: CrewRosterEntry;
  readonly environmentId: EnvironmentId;
  readonly here: boolean;
  readonly onOpen: () => void;
}) {
  const { entry } = props;
  const shell = useThreadShell(
    entry.tone === "working" ? scopeThreadRef(props.environmentId, entry.threadId) : null,
  );
  const startedAt = shell ? resolveThreadWorkingStartedAt(shell) : null;
  return (
    <ThreadDetailsControl
      part="row"
      aria-current={props.here ? "page" : undefined}
      onClick={props.onOpen}
    >
      {props.here ? <CrewRosterHereMark /> : null}
      <CrewRosterIcon tone={entry.tone} />
      <span className="min-w-0 flex-1 truncate text-start">
        {entry.name}
        {entry.kind === "lead" ? <span className="text-muted-foreground"> · lead</span> : null}
      </span>
      <CrewRosterStatus entry={entry} />
      {startedAt ? (
        <span className="shrink-0 text-xs text-info-foreground tabular-nums">
          · <WorkingDuration startedAt={startedAt} />
        </span>
      ) : null}
    </ThreadDetailsControl>
  );
}
