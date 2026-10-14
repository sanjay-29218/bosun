import { CAPTAIN_BOT_ID } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "../../composerDraftStore";
import { botDefaultWorkflowId, resolveDraftWorkflowId, useCrewDraftStore } from "./crewDraftStore";

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

    // Starting a feature clears the pick: the emptied draft is reused and follows the default.
    useCrewDraftStore.getState().clearWorkflow(draftId);
    expect(resolveDraftWorkflowId(pickFor(draftId), "ship-a-feature")).toBe("ship-a-feature");
  });
});

describe("bot default workflow", () => {
  const bots = [
    { id: CAPTAIN_BOT_ID, defaultWorkflowId: "ship-a-feature" },
    { id: "bot-social", defaultWorkflowId: null },
  ];

  it("comes from the project's bot, and Captain owns projects without one", () => {
    expect(botDefaultWorkflowId(bots, {})).toBe("ship-a-feature");
    expect(botDefaultWorkflowId(bots, { botId: "bot-social" })).toBeNull();
    // A bot this client hasn't loaded yet gives no default rather than Captain's.
    expect(botDefaultWorkflowId(bots, { botId: "bot-finance" })).toBeNull();
  });
});
