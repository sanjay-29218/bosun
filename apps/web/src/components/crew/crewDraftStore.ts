import type { DraftId } from "../../composerDraftStore";
import { create } from "zustand";

/**
 * The workflow a new thread's composer will start, per draft. Session-only on purpose: after a
 * reload the draft falls back to "No workflow", a normal thread, which is the safe default.
 */
export const useCrewDraftStore = create<{
  readonly workflowByDraftId: Readonly<Record<string, string>>;
  readonly setWorkflow: (draftId: DraftId, workflowId: string | null) => void;
}>((set) => ({
  workflowByDraftId: {},
  setWorkflow: (draftId, workflowId) =>
    set((state) => {
      const { [draftId]: _previous, ...rest } = state.workflowByDraftId;
      return { workflowByDraftId: workflowId === null ? rest : { ...rest, [draftId]: workflowId } };
    }),
}));
