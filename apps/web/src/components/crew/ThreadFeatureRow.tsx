import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  featureIssueRef,
  isStandingThread,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronRightIcon, CircleDotIcon, WorkflowIcon } from "lucide-react";

import { useThreadShell } from "../../state/entities";
import { useWorkGroup } from "../../state/workGroup";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { openFeatureIssueDialog } from "./FeatureIssue";
import { FeatureIssueIcon } from "./FeatureIssueIcon";
import { FeatureTag } from "./FeatureTag";
import { openFeatureIssue } from "../features/todoDialogs";

/**
 * The feature or bot request a thread works on, in its details panel: a row that opens the Crew
 * tab, and its linked issue, which opens in the todo sheet. A thread without one, feature or not,
 * offers to link one. Its crew is its own section, `ThreadCrewSection`.
 */
export function ThreadFeatureRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpenFeature?: (() => void) | undefined;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useThreadShell(threadRef);
  const group = useWorkGroup(thread?.feature || thread?.crewRequest ? threadRef : null);
  if (!thread) return null;
  const feature = thread.feature;
  const issue = thread.issue ?? feature?.issue;
  // A feature links one issue for all its threads; any other thread links its own. A standing
  // thread works on its project or bot as a whole.
  const linkIssue =
    issue || isStandingThread(thread.id)
      ? null
      : () =>
          openFeatureIssueDialog(
            feature
              ? {
                  environmentId: thread.environmentId,
                  projectId: thread.projectId,
                  featureId: feature.id,
                  featureTitle: feature.title,
                  issue: null,
                }
              : {
                  environmentId: thread.environmentId,
                  projectId: thread.projectId,
                  threadId: thread.id,
                  threadTitle: thread.title,
                  issue: null,
                },
          );
  if (!group && !issue && !linkIssue) return null;
  return (
    <>
      {group ? (
        <ThreadDetailsControl
          part="row"
          aria-label={`${feature ? "Feature" : "Request"} ${group.title}, open the Crew tab`}
          disabled={!props.onOpenFeature}
          onClick={props.onOpenFeature}
        >
          <WorkflowIcon className="text-muted-foreground" />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {feature ? (
              <FeatureTag feature={feature} fill />
            ) : (
              <span className="min-w-0 truncate">{group.title}</span>
            )}
          </span>
          {props.onOpenFeature ? <ChevronRightIcon className="text-muted-foreground" /> : null}
        </ThreadDetailsControl>
      ) : null}
      {issue ? (
        <ThreadDetailsControl
          part="row"
          aria-label={`Open ${featureIssueRef(issue)} ${issue.title}`}
          onClick={() => openFeatureIssue(thread, issue)}
        >
          <FeatureIssueIcon issue={issue} />
          <span className="min-w-0 truncate">
            {featureIssueRef(issue)} {issue.title}
          </span>
        </ThreadDetailsControl>
      ) : linkIssue ? (
        <ThreadDetailsControl part="row" tone="muted" onClick={linkIssue}>
          <CircleDotIcon />
          Link issue…
        </ThreadDetailsControl>
      ) : null}
    </>
  );
}
