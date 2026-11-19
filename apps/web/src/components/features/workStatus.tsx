import {
  WORK_ROW_LABELS,
  featurePullRequest,
  featureWorkStatus,
  type EnvironmentFeatureCard,
  type WorkRowStatus,
} from "@t3tools/client-runtime/state/crew-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  CircleAlertIcon,
  CircleDashedIcon,
  CircleIcon,
  CirclePauseIcon,
  EyeIcon,
  MessageCircleQuestionIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { PULL_REQUEST_STATE_PRESENTATION, PullRequestGlyph } from "../pullRequest/pullRequestIcons";

/** How every surface shows where a feature stands; the words come from `WORK_ROW_LABELS`. */
export const WORK_LOOK: Record<
  WorkRowStatus,
  { readonly label: string; readonly icon: LucideIcon; readonly className: string }
> = {
  "needs-input": {
    label: WORK_ROW_LABELS["needs-input"],
    icon: MessageCircleQuestionIcon,
    className: "text-warning-foreground",
  },
  working: {
    label: WORK_ROW_LABELS.working,
    icon: CircleDashedIcon,
    className: "text-info-foreground",
  },
  waiting: {
    label: WORK_ROW_LABELS.waiting,
    icon: CirclePauseIcon,
    className: "text-muted-foreground",
  },
  failed: {
    label: WORK_ROW_LABELS.failed,
    icon: CircleAlertIcon,
    className: "text-error-foreground",
  },
  review: { label: WORK_ROW_LABELS.review, icon: EyeIcon, className: "text-success-foreground" },
  done: {
    label: WORK_ROW_LABELS.done,
    icon: PullRequestGlyph.merged,
    className: PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
  },
  "not-started": {
    label: WORK_ROW_LABELS["not-started"],
    icon: CircleIcon,
    className: "text-muted-foreground",
  },
};

/** Where a feature stands, the thread that puts it there, and its pull request. */
export function featureWork(
  card: EnvironmentFeatureCard,
  threads: ReadonlyArray<EnvironmentThreadShell>,
) {
  const work = featureWorkStatus(card, threads);
  return {
    ...work,
    look: WORK_LOOK[work.status],
    pullRequest: featurePullRequest(card, threads),
  };
}

export function WorkIcon(props: { readonly status: WorkRowStatus; readonly className?: string }) {
  const look = WORK_LOOK[props.status];
  return (
    <look.icon
      aria-label={look.label}
      className={cn("size-4 shrink-0", look.className, props.className)}
    />
  );
}
