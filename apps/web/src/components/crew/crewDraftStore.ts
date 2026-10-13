import type { DraftId } from "../../composerDraftStore";
import { create } from "zustand";

/**
 * The workflow a new thread's composer will start, per draft. `null` is a pick of "No
 * workflow"; a draft with no pick follows the default. Session-only on purpose: after a
 * reload the draft falls back to the default.
 */
export const useCrewDraftStore = create<{
  readonly workflowByDraftId: Readonly<Record<string, string | null>>;
  readonly setWorkflow: (draftId: DraftId, workflowId: string | null) => void;
}>((set) => ({
  workflowByDraftId: {},
  setWorkflow: (draftId, workflowId) =>
    set((state) => ({ workflowByDraftId: { ...state.workflowByDraftId, [draftId]: workflowId } })),
}));

/** A draft's workflow: what was picked, or the default until something is. */
export function resolveDraftWorkflowId(
  picked: string | null | undefined,
  defaultWorkflowId: string | null,
): string | null {
  return picked === undefined ? defaultWorkflowId : picked;
}
