import type { FeatureIssue } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDotIcon } from "lucide-react";

import { cn } from "../../lib/utils";

/** Open issues in green and closed ones in the primary color, close to how GitHub shows them. */
export function FeatureIssueIcon(props: {
  readonly issue: Pick<FeatureIssue, "state">;
  readonly className?: string;
}) {
  const Icon = props.issue.state === "open" ? CircleDotIcon : CircleCheckIcon;
  return (
    <Icon
      aria-label={props.issue.state === "open" ? "Open issue" : "Closed issue"}
      className={cn(
        "shrink-0",
        props.issue.state === "open" ? "text-success" : "text-primary",
        props.className,
      )}
    />
  );
}
