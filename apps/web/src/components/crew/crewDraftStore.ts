import { CAPTAIN_BOT_ID } from "@t3tools/contracts";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { create } from "zustand";

/**
 * The workflow a new thread's composer will start, per draft. `null` is a pick of "No
 * workflow"; a draft with no pick follows the default. Session-only on purpose: after a
 * reload the draft falls back to the default.
 */
export const useCrewDraftStore = create<{
  readonly workflowByDraftId: Readonly<Record<string, string | null>>;
  /** Drafts New feature or Start feature opened, which start on a workflow; see below. */
  readonly featureDraftIds: Readonly<Record<string, true>>;
  readonly setWorkflow: (draftId: DraftId, workflowId: string | null) => void;
  readonly setFeatureDraft: (draftId: DraftId, feature: boolean) => void;
  /** Drops the pick, so a reused draft follows the default again. */
  readonly clearWorkflow: (draftId: DraftId) => void;
}>((set) => ({
  workflowByDraftId: {},
  featureDraftIds: {},
  setFeatureDraft: (draftId, feature) =>
    set((state) => {
      const { [draftId]: _previous, ...rest } = state.featureDraftIds;
      return { featureDraftIds: feature ? { ...rest, [draftId]: true } : rest };
    }),
  setWorkflow: (draftId, workflowId) => {
    set((state) => ({ workflowByDraftId: { ...state.workflowByDraftId, [draftId]: workflowId } }));
    // A feature's stages share one workspace, so it gets its own worktree unless changed back.
    if (workflowId !== null) {
      useComposerDraftStore.getState().setDraftThreadContext(draftId, { envMode: "worktree" });
    }
  },
  clearWorkflow: (draftId) =>
    set((state) => {
      const { [draftId]: _previous, ...rest } = state.workflowByDraftId;
      const { [draftId]: _feature, ...features } = state.featureDraftIds;
      return { workflowByDraftId: rest, featureDraftIds: features };
    }),
}));

/** A draft's workflow: what was picked, else what it starts on until something is. */
export function resolveDraftWorkflowId(
  picked: string | null | undefined,
  unpicked: string | null,
): string | null {
  return picked === undefined ? unpicked : picked;
}

/**
 * What a draft starts on before any pick: a draft New feature or Start feature opened takes the
 * bot's default workflow, else the first one; a plain new thread takes none.
 */
export function unpickedDraftWorkflowId(input: {
  readonly featureDraft: boolean;
  readonly botDefault: string | null;
  readonly firstWorkflow: string | null;
}): string | null {
  return input.featureDraft ? (input.botDefault ?? input.firstWorkflow) : null;
}

/** The default workflow of the bot that owns a project; a project without a bot is Captain's. */
export function botDefaultWorkflowId(
  bots: ReadonlyArray<{ readonly id: string; readonly defaultWorkflowId: string | null }>,
  project: { readonly botId?: string | undefined },
): string | null {
  const botId = project.botId ?? CAPTAIN_BOT_ID;
  return bots.find((bot) => bot.id === botId)?.defaultWorkflowId ?? null;
}
