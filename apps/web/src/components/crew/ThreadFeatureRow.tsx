import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { featureIssueRef, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { ChevronRightIcon, CircleDotIcon, PencilIcon, WorkflowIcon } from "lucide-react";

import { useThreadShell } from "../../state/entities";
import { useWorkGroup } from "../../state/workGroup";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS } from "../chat/threadDetailsPanelStyles";
import { FeatureIssueIcon, openFeatureIssueDialog } from "./FeatureIssue";
import { FeatureTag } from "./FeatureTag";
import { openFeatureIssue } from "../features/todoDialogs";

/**
 * The feature or bot request a thread works on, in its details panel: a row that opens the Crew
 * tab, and its linked issue. Its crew is its own section, `ThreadCrewSection`.
 */
export function ThreadFeatureRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpenFeature?: (() => void) | undefined;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useThreadShell(threadRef);
  const group = useWorkGroup(thread?.feature || thread?.crewRequest ? threadRef : null);
  if (!thread || !group) return null;
  const feature = thread.feature;
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
