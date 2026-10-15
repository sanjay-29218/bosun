import { CREW_STATE_LABELS, formatCrewStageLine } from "@t3tools/client-runtime/crew-stage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, CircleDotIcon, PencilIcon, WorkflowIcon } from "lucide-react";

import { readLocalApi } from "../../localApi";
import { useThreadShell, useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS } from "../chat/threadDetailsPanelStyles";
import { FeatureIssueIcon, openFeatureIssueDialog } from "./FeatureIssue";
import { FeatureTag } from "./FeatureTag";

/**
 * The feature a thread works on, in its details panel, with where the feature stands. A stage
 * thread opens the feature's panel; another of its threads (the project manager's) opens the
 * feature's current stage thread.
 */
export function ThreadFeatureRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpenFeature?: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const thread = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const shells = useThreadShells(thread?.feature != null && !thread.crew?.current);
  const feature = thread?.feature;
  if (!thread || !feature) return null;
  const stage = thread.crew?.current
    ? thread
    : shells.find(
        (shell) =>
          shell.environmentId === thread.environmentId &&
          shell.feature?.id === feature.id &&
          shell.crew?.current,
      );
  const open =
    thread.crew && props.onOpenFeature
      ? props.onOpenFeature
      : stage && stage.id !== thread.id
        ? () =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(stage.environmentId, stage.id)),
            })
        : undefined;
  const editIssue = () =>
    openFeatureIssueDialog({
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      featureId: feature.id,
      featureTitle: feature.title,
      issue: feature.issue ?? null,
    });
  const issue = feature.issue;
  return (
    <>
      <ThreadDetailsControl
        part="row"
        aria-label={`Feature ${feature.title}`}
        disabled={!open}
        onClick={open}
      >
        <WorkflowIcon className="text-muted-foreground" />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <FeatureTag feature={feature} />
          {stage?.crew ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {formatCrewStageLine(stage.crew)} · {CREW_STATE_LABELS[stage.crew.state]}
            </span>
          ) : null}
        </span>
        {open ? <ChevronRightIcon className="text-muted-foreground" /> : null}
      </ThreadDetailsControl>
      {issue ? (
        <div className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}>
          <ThreadDetailsControl
            part="primary"
            aria-label={`Open issue #${issue.number} ${issue.title}`}
            onClick={() => void readLocalApi()?.shell.openExternal(issue.url)}
          >
            <FeatureIssueIcon issue={issue} />
            <span className="min-w-0 truncate">
              #{issue.number} {issue.title}
            </span>
          </ThreadDetailsControl>
          <ThreadDetailsControl part="secondary" aria-label="Change issue" onClick={editIssue}>
            <PencilIcon className="size-3.5 text-muted-foreground" />
          </ThreadDetailsControl>
        </div>
      ) : (
        <ThreadDetailsControl part="row" tone="muted" onClick={editIssue}>
          <CircleDotIcon />
          Link issue…
        </ThreadDetailsControl>
      )}
    </>
  );
}
