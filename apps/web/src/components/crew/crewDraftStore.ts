import { create } from "zustand";

import type { DraftId } from "../../composerDraftStore";

/**
 * Drafts New feature or Start feature opened: their first message starts a feature, as its
 * brief. Session-only on purpose: after a reload the draft is a plain new thread.
 */
export const useCrewDraftStore = create<{
  readonly featureDraftIds: Readonly<Record<string, true>>;
  readonly setFeatureDraft: (draftId: DraftId, feature: boolean) => void;
}>((set) => ({
  featureDraftIds: {},
  setFeatureDraft: (draftId, feature) =>
    set((state) => {
      const { [draftId]: _previous, ...rest } = state.featureDraftIds;
      return { featureDraftIds: feature ? { ...rest, [draftId]: true } : rest };
    }),
}));
