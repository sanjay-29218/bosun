import type { ModelSelection, SnapshotRole } from "@t3tools/contracts";

import { FEATURE_LEAD_INSTRUCTIONS } from "./crewPrompts.ts";

/**
 * Peers from before workflows lost their lead role refuse a workflow that names none, and lead
 * with that role's text. Newer peers skip the built-in text and never add the role.
 */
export const OLDER_PEER_LEAD_ROLE_ID = "role:feature-manager";

export const olderPeerLeadRole = (modelSelection: ModelSelection) =>
  ({
    id: OLDER_PEER_LEAD_ROLE_ID,
    name: "Feature manager",
    instructions: FEATURE_LEAD_INSTRUCTIONS,
    modelSelection,
    runtimeMode: "full-access",
  }) satisfies SnapshotRole;
