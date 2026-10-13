import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "../../composerDraftStore";
import { resolveDraftWorkflowId, useCrewDraftStore } from "./crewDraftStore";

const pickFor = (draftId: string) =>
  useCrewDraftStore.getState().workflowByDraftId[draftId as DraftId];

describe("draft workflow", () => {
  it("follows the default until a pick, and a pick of None sticks", () => {
    const draftId = "draft-1" as DraftId;
    expect(resolveDraftWorkflowId(pickFor(draftId), "ship-a-feature")).toBe("ship-a-feature");

    useCrewDraftStore.getState().setWorkflow(draftId, null);
    expect(resolveDraftWorkflowId(pickFor(draftId), "ship-a-feature")).toBeNull();

    useCrewDraftStore.getState().setWorkflow(draftId, "bug-fix");
    expect(resolveDraftWorkflowId(pickFor(draftId), "ship-a-feature")).toBe("bug-fix");
    expect(resolveDraftWorkflowId(pickFor("draft-2"), null)).toBeNull();
  });
});
