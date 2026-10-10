import { RegistryContext } from "@effect/atom-react";
import {
  FEATURE_CARD_ACTION_LABELS,
  featureCardActions,
  sendBackTargets,
  stageLabel,
  type EnvironmentFeatureCard,
  type FeatureCardActionId,
} from "@t3tools/client-runtime/state/crew-board";
import {
  runAtomCommand,
  type AtomCommand,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuItem, WorkflowDefinition } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { useCallback, useContext, useMemo } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readLocalApi } from "../../localApi";
import { featuresEnvironment } from "../../state/features";
import { formatEnvironmentQueryError } from "../../state/query";
import { workflowsEnvironment } from "../../state/workflows";
import { toastManager } from "../ui/toast";

/** Actions that need text from you first: the page opens a note dialog for them. */
export type FeatureNoteAction = "request-changes" | "answer";
export interface FeatureNoteRequest {
  readonly card: EnvironmentFeatureCard;
  readonly action: FeatureNoteAction;
}

type MenuId =
  | "open"
  | "copy-branch"
  | FeatureCardActionId
  | `send-back:${string}`
  | `reopen-at:${string}`;

/** The workflow a feature runs, pinned at its version, for stage pickers. */
function readFeatureDefinition(card: EnvironmentFeatureCard) {
  return Effect.runPromise(
    AtomRegistry.getResult(
      // A one-shot read reuses a cached snapshot when the stage thread already loaded one.
      appAtomRegistry,
      workflowsEnvironment.feature({
        environmentId: card.environmentId,
        input: { projectId: card.projectId, featureId: card.featureId },
      }),
      { suspendOnWaiting: true },
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.map((snapshot): WorkflowDefinition | null => snapshot?.definition ?? null),
      Effect.orElseSucceed(() => null),
    ),
  );
}

/**
 * Runs feature actions and opens a card's menu. Every action is the same RPC the stage
 * thread, the command palette and MCP use; the board moves when the server answers.
 */
export function useFeatureActions(options: {
  readonly onNoteRequest: (request: FeatureNoteRequest) => void;
  readonly branchFor?: (card: EnvironmentFeatureCard) => string | null;
}) {
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const { onNoteRequest, branchFor } = options;

  const report = useCallback((label: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Success" || Cause.hasInterruptsOnly(result.cause)) return true;
    toastManager.add({
      type: "error",
      title: `Could not ${label.toLowerCase().replace(/…$/, "")}`,
      description: formatEnvironmentQueryError(result.cause),
    });
    return false;
  }, []);

  const command = useCallback(
    <W, A, E>(label: string, atomCommand: AtomCommand<W, A, E>, input: W) =>
      runAtomCommand(registry, atomCommand, input, { reportFailure: false }).then((result) =>
        report(label, result),
      ),
    [registry, report],
  );

  const run = useCallback(
    async (
      card: EnvironmentFeatureCard,
      action: FeatureCardActionId,
      extra: { readonly text?: string; readonly stepId?: string } = {},
    ): Promise<boolean> => {
      const target = { projectId: card.projectId, featureId: card.featureId };
      const environmentId = card.environmentId;
      const requestId = randomUUID();
      const label = FEATURE_CARD_ACTION_LABELS[action];
      const withRequest = { environmentId, input: { ...target, requestId } };
      switch (action) {
        case "start":
          return command(label, featuresEnvironment.start, { environmentId, input: target });
        case "start-now":
          return command(label, featuresEnvironment.startNow, { environmentId, input: target });
        case "reopen":
          return command(label, featuresEnvironment.reopen, {
            environmentId,
            input: {
              ...target,
              requestId,
              ...(extra.stepId === undefined ? {} : { stepId: extra.stepId }),
            },
          });
        case "approve":
          return command(label, featuresEnvironment.approve, withRequest);
        case "request-changes":
          if (!extra.text) {
            onNoteRequest({ card, action });
            return false;
          }
          return command(label, featuresEnvironment.requestChanges, {
            environmentId,
            input: { ...target, requestId, note: extra.text },
          });
        case "answer":
          if (!extra.text) {
            onNoteRequest({ card, action });
            return false;
          }
          return command(label, featuresEnvironment.answer, {
            environmentId,
            input: { ...target, requestId, text: extra.text },
          });
        case "retry":
          return command(label, featuresEnvironment.retry, withRequest);
        case "take-over":
          return command(label, featuresEnvironment.takeOver, withRequest);
        case "send-back":
          if (!extra.stepId) return false;
          return command(label, featuresEnvironment.sendBack, {
            environmentId,
            input: { ...target, requestId, stepId: extra.stepId },
          });
        case "skip":
          return command(label, featuresEnvironment.skip, withRequest);
        case "accept-as-is":
          return command(label, featuresEnvironment.acceptAsIs, withRequest);
        case "one-more-round":
          return command(label, featuresEnvironment.oneMoreRound, withRequest);
        case "pause":
          return command(label, featuresEnvironment.pause, withRequest);
        case "resume":
          return command(label, featuresEnvironment.resume, withRequest);
        case "cancel":
          return command(label, featuresEnvironment.cancel, withRequest);
      }
    },
    [command, onNoteRequest],
  );

  const openCard = useCallback(
    (card: EnvironmentFeatureCard) => {
      if (!card.threadId) return false;
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: card.environmentId, threadId: card.threadId },
      });
      return true;
    },
    [navigate],
  );

  /** Reopening Done starts a follow-up at a stage you pick; Cancelled resumes where it stopped. */
  const reopenStageItems = useCallback(
    async (card: EnvironmentFeatureCard): Promise<ContextMenuItem<MenuId>[] | null> => {
      if (card.state !== "done") return null;
      const definition = await readFeatureDefinition(card);
      if (!definition) return null;
      return Object.keys(definition.steps)
        .filter((id) => definition.steps[id]?.type === "task")
        .map((id) => ({ id: `reopen-at:${id}` as const, label: stageLabel(id) }));
    },
    [],
  );

  const showMenu = useCallback(
    async (card: EnvironmentFeatureCard, position: { readonly x: number; readonly y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const actions = featureCardActions(card);
      const definition =
        actions.includes("send-back") && card.stage ? await readFeatureDefinition(card) : null;
      const items: ContextMenuItem<MenuId>[] = [];
      if (card.threadId)
        items.push({
          id: "open",
          label: card.stage ? `Open ${stageLabel(card.stage.stepId)}` : "Open stage thread",
        });
      for (const action of actions) {
        const separatorBefore = action === "cancel" || (items.length > 0 && action === actions[0]);
        if (action === "send-back") {
          const targets =
            definition && card.stage ? sendBackTargets(definition, card.stage.stepId) : [];
          items.push({
            id: action,
            label: FEATURE_CARD_ACTION_LABELS[action],
            disabled: targets.length === 0,
            ...(separatorBefore ? { separatorBefore } : {}),
            children: targets.map((stepId) => ({
              id: `send-back:${stepId}` as const,
              label: stageLabel(stepId),
            })),
          });
          continue;
        }
        if (action === "reopen") {
          const stages = await reopenStageItems(card);
          items.push({
            id: action,
            label: FEATURE_CARD_ACTION_LABELS[action],
            ...(separatorBefore ? { separatorBefore } : {}),
            ...(stages ? { children: stages } : {}),
          });
          continue;
        }
        items.push({
          id: action,
          label: FEATURE_CARD_ACTION_LABELS[action],
          ...(action === "cancel" ? { destructive: true } : {}),
          ...(separatorBefore ? { separatorBefore } : {}),
        });
        if (action === "pause" || action === "resume") {
          const branch = branchFor?.(card);
          if (branch) items.push({ id: "copy-branch", label: "Copy branch name" });
        }
      }
      let clicked: MenuId | null = null;
      try {
        clicked = await api.contextMenu.show(items, position);
      } catch {
        return;
      }
      if (clicked === null) return;
      if (clicked === "open") openCard(card);
      else if (clicked === "copy-branch") {
        const branch = branchFor?.(card);
        if (branch) void writeTextToClipboard(branch, "branch name").catch(() => undefined);
      } else if (clicked.startsWith("send-back:"))
        void run(card, "send-back", { stepId: clicked.slice("send-back:".length) });
      else if (clicked.startsWith("reopen-at:"))
        void run(card, "reopen", { stepId: clicked.slice("reopen-at:".length) });
      else void run(card, clicked as FeatureCardActionId);
    },
    [branchFor, openCard, reopenStageItems, run],
  );

  /** Drag out of Done reopens: Done asks where the follow-up starts, Cancelled resumes. */
  const reopenFromDrop = useCallback(
    async (card: EnvironmentFeatureCard, position: { readonly x: number; readonly y: number }) => {
      const stages = await reopenStageItems(card);
      if (!stages) return run(card, "reopen");
      const api = readLocalApi();
      if (!api) return false;
      let clicked: MenuId | null = null;
      try {
        clicked = await api.contextMenu.show(
          [{ id: "reopen", label: "Start the follow-up at…", header: true }, ...stages],
          position,
        );
      } catch {
        return false;
      }
      if (!clicked?.startsWith("reopen-at:")) return false;
      return run(card, "reopen", { stepId: clicked.slice("reopen-at:".length) });
    },
    [reopenStageItems, run],
  );

  return useMemo(
    () => ({ run, openCard, showMenu, reopenFromDrop }),
    [openCard, reopenFromDrop, run, showMenu],
  );
}
