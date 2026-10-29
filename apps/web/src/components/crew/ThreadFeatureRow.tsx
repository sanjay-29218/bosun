import { CREW_STATE_LABELS } from "@t3tools/client-runtime/crew-stage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { featureIssueRef, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  PencilIcon,
  WorkflowIcon,
} from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useThreadShell } from "../../state/entities";
import { useWorkGroup } from "../../state/workGroup";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS } from "../chat/threadDetailsPanelStyles";
import { WorkStageStrip } from "../sidebar/SidebarWorkGroup";
import { CrewRosterIcon, CrewRosterStatus } from "./CrewRosterIcon";
import { buildCrewRoster } from "@t3tools/client-runtime/state/crew-roster";
import { FeatureIssueIcon, openFeatureIssueDialog } from "./FeatureIssue";
import { FeatureTag } from "./FeatureTag";
import { openFeatureIssue } from "../features/todoDialogs";
import { useCrewStageContext } from "./useCrewStage";

const STEPS_OPEN_KEY = "t3code:thread-details:crew-steps-open";

/**
 * The feature or bot request a thread works on, in its details panel: a row that opens the Crew
 * tab, where the work stands, and its crew folded underneath for a quick jump between threads.
 */
export function ThreadFeatureRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpenFeature?: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useThreadShell(threadRef);
  const group = useWorkGroup(thread?.feature || thread?.crewRequest ? threadRef : null);
  const stage = useCrewStageContext();
  const [stepsOpen, setStepsOpen] = useLocalStorage(STEPS_OPEN_KEY, false, Schema.Boolean);
  if (!thread || !group) return null;
  const feature = thread.feature;
  const snapshot = stage?.thread.id === thread.id ? stage.snapshot : null;
  const roster = buildCrewRoster(group, snapshot);
  const current = group.kind === "feature" ? group.primary.crew : null;
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, threadId)),
    });
  const editIssue = feature
    ? () =>
        openFeatureIssueDialog({
          environmentId: thread.environmentId,
          projectId: thread.projectId,
          featureId: feature.id,
          featureTitle: feature.title,
          issue: feature.issue ?? null,
        })
    : null;
  const issue = feature?.issue;
  return (
    <>
      <ThreadDetailsControl
        part="row"
        aria-label={`${feature ? "Feature" : "Request"} ${group.title}, open the Crew tab`}
        disabled={!props.onOpenFeature}
        onClick={props.onOpenFeature}
      >
        <WorkflowIcon className="text-muted-foreground" />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {feature ? (
            <FeatureTag feature={feature} />
          ) : (
            <span className="min-w-0 truncate">{group.title}</span>
          )}
        </span>
        {props.onOpenFeature ? <ChevronRightIcon className="text-muted-foreground" /> : null}
      </ThreadDetailsControl>
      <ThreadDetailsControl
        part="row"
        aria-expanded={stepsOpen}
        aria-label={`${stepsOpen ? "Hide" : "Show"} its crew`}
        onClick={() => setStepsOpen(!stepsOpen)}
      >
        {stepsOpen ? (
          <ChevronDownIcon className="text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="text-muted-foreground" />
        )}
        <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
          {group.stages.length > 0 ? <WorkStageStrip stages={group.stages} /> : null}
          <span className="min-w-0 truncate">
            {current && group.stageLine
              ? `${group.stageLine} · ${CREW_STATE_LABELS[current.state]}`
              : roster.map((entry) => entry.name).join(" → ")}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{roster.length}</span>
      </ThreadDetailsControl>
      {stepsOpen
        ? roster.map((entry) => (
            <ThreadDetailsControl
              key={entry.key}
              part="row"
              disabled={entry.threadId === null}
              aria-current={entry.threadId === thread.id ? "page" : undefined}
              onClick={entry.threadId ? () => openThread(entry.threadId!) : undefined}
            >
              <CrewRosterIcon tone={entry.tone} />
              <span className="min-w-0 flex-1 truncate text-start">
                {entry.name}
                <span className="text-muted-foreground">
                  {entry.kind === "lead" ? " · lead" : entry.role ? ` · ${entry.role}` : ""}
                </span>
              </span>
              {entry.threadId === thread.id ? (
                <span className="shrink-0 rounded-sm border px-1 text-2xs text-muted-foreground">
                  You're here
                </span>
              ) : (
                <CrewRosterStatus entry={entry} />
              )}
            </ThreadDetailsControl>
          ))
        : null}
      {issue ? (
        <div className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}>
          <ThreadDetailsControl
            part="primary"
            aria-label={`Open ${featureIssueRef(issue)} ${issue.title}`}
            onClick={() => openFeatureIssue(thread, issue)}
          >
            <FeatureIssueIcon issue={issue} />
            <span className="min-w-0 truncate">
              {featureIssueRef(issue)} {issue.title}
            </span>
          </ThreadDetailsControl>
          {editIssue ? (
            <ThreadDetailsControl part="secondary" aria-label="Change issue" onClick={editIssue}>
              <PencilIcon className="size-3.5 text-muted-foreground" />
            </ThreadDetailsControl>
          ) : null}
        </div>
      ) : editIssue ? (
        <ThreadDetailsControl part="row" tone="muted" onClick={editIssue}>
          <CircleDotIcon />
          Link issue…
        </ThreadDetailsControl>
      ) : null}
    </>
  );
}
