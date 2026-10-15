import { featureTagColor } from "@t3tools/client-runtime/crew-stage";
import type { ThreadFeatureTag } from "@t3tools/contracts";
import type { CSSProperties } from "react";

import { Badge } from "../ui/badge";

/** The feature a thread works on, in the feature's color, so its threads read as one group. */
export function FeatureTag({ feature }: { feature: ThreadFeatureTag }) {
  return (
    <Badge
      size="sm"
      variant="label"
      className="min-w-0 max-w-32 shrink justify-start"
      style={{ "--label": featureTagColor(feature.id) } as CSSProperties}
    >
      <span className="truncate">{feature.title}</span>
    </Badge>
  );
}
