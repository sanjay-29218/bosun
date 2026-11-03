import { create } from "zustand";

import type { DraftId } from "../../composerDraftStore";

/**
 * Drafts New feature or Start feature opened: their first message starts a feature, as its
 * brief, on the workflow picked for the draft or else Feature delivery. Session-only on
 * purpose: after a reload the draft is a plain new thread.
 */
export const useCrewDraftStore = create<{
  readonly featureDraftIds: Readonly<Record<string, true>>;
  readonly workflowByDraftId: Readonly<Record<string, string>>;
  readonly setFeatureDraft: (draftId: DraftId, feature: boolean) => void;
  readonly setWorkflow: (draftId: DraftId, workflowId: string) => void;
}>((set) => ({
  featureDraftIds: {},
  workflowByDraftId: {},
  setFeatureDraft: (draftId, feature) =>
    set((state) => {
      const { [draftId]: _previous, ...rest } = state.featureDraftIds;
      const { [draftId]: _workflow, ...workflows } = state.workflowByDraftId;
      return {
        featureDraftIds: feature ? { ...rest, [draftId]: true } : rest,
        workflowByDraftId: workflows,
      };
    }),
  setWorkflow: (draftId, workflowId) =>
    set((state) => ({ workflowByDraftId: { ...state.workflowByDraftId, [draftId]: workflowId } })),
}));
