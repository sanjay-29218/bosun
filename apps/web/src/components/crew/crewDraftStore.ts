import { CAPTAIN_BOT_ID } from "@t3tools/contracts";

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

/** The default workflow of the bot that owns a project; a project without a bot is Captain's. */
export function botDefaultWorkflowId(
  bots: ReadonlyArray<{ readonly id: string; readonly defaultWorkflowId: string | null }>,
  project: { readonly botId?: string | undefined },
): string | null {
  const botId = project.botId ?? CAPTAIN_BOT_ID;
  return bots.find((bot) => bot.id === botId)?.defaultWorkflowId ?? null;
}
