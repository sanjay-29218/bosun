import { CREW_STATE_LABELS, formatCrewStageLine } from "@t3tools/client-runtime/crew-stage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, WorkflowIcon } from "lucide-react";

import { useThreadShell, useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
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
  return (
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
  );
}
