import { featureTagColor } from "@t3tools/client-runtime/feature-tag";
import type { ThreadFeatureTag } from "@t3tools/contracts";
import type { CSSProperties } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

/**
 * The feature a thread works on, in the feature's color, so its threads read as one group. Beside
 * other row content it stays short; `fill` lets it take the row's width where it stands alone.
 */
export function FeatureTag({
  feature,
  fill = false,
}: {
  feature: ThreadFeatureTag;
  fill?: boolean;
}) {
  return (
    <Badge
      size="sm"
      variant="label"
      className={cn("min-w-0 shrink justify-start", fill ? "max-w-full" : "max-w-32")}
      style={{ "--label": featureTagColor(feature.id) } as CSSProperties}
    >
      <span className="truncate">{feature.title}</span>
    </Badge>
  );
}
