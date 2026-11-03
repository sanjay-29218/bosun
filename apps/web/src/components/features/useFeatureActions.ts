import { RegistryContext } from "@effect/atom-react";
import {
  FEATURE_CARD_ACTION_LABELS,
  featureCardActions,
  type EnvironmentFeatureCard,
  type FeatureCardActionId,
} from "@t3tools/client-runtime/state/crew-board";
import {
  runAtomCommand,
  type AtomCommand,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { featureIssueRef, type ContextMenuItem, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { useContext } from "react";

import { readLocalApi } from "../../localApi";
import { featuresEnvironment } from "../../state/features";
import { formatEnvironmentQueryError } from "../../state/query";
import { openFeatureIssueDialog } from "../crew/FeatureIssue";
import { openFeatureIssue } from "./todoDialogs";
import { toastManager } from "../ui/toast";

type MenuId = "open" | "issue" | "open-issue" | FeatureCardActionId;

/**
 * Runs feature actions and opens a card's menu. Each is the same RPC the command palette and
 * MCP use; the board moves when the server answers.
 */
export function useFeatureActions() {
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();

  const report = (label: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Success" || Cause.hasInterruptsOnly(result.cause)) return true;
    toastManager.add({
      type: "error",
      title: `Could not ${label.toLowerCase()}`,
      description: formatEnvironmentQueryError(result.cause),
    });
    return false;
  };

  const command = <W, A, E>(atomCommand: AtomCommand<W, A, E>, input: W) =>
    runAtomCommand(registry, atomCommand, input, { reportFailure: false });

  const openThread = (card: EnvironmentFeatureCard, threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: card.environmentId, threadId },
    });

  const run = async (card: EnvironmentFeatureCard, action: FeatureCardActionId) => {
    const environmentId = card.environmentId;
    const target = { projectId: card.projectId, featureId: card.featureId };
    const label = FEATURE_CARD_ACTION_LABELS[action];
    if (action === "start") {
      const result = await command(featuresEnvironment.start, { environmentId, input: target });
      if (result._tag === "Success") openThread(card, result.value.leadThreadId);
      return report(label, result);
    }
    const status = action === "close" ? "closed" : "open";
    return report(
      label,
      await command(featuresEnvironment.setStatus, {
        environmentId,
        input: { ...target, status },
      }),
    );
  };

  /** Opens the feature's lead; a feature not started yet has none. */
  const openCard = (card: EnvironmentFeatureCard) => {
    if (!card.leadThreadId) return false;
    openThread(card, card.leadThreadId);
    return true;
  };

  const showMenu = async (
    card: EnvironmentFeatureCard,
    position: { readonly x: number; readonly y: number },
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const items: ContextMenuItem<MenuId>[] = [];
    if (card.leadThreadId) items.push({ id: "open", label: "Open lead thread" });
    for (const [index, action] of featureCardActions(card).entries()) {
      items.push({
        id: action,
        label: FEATURE_CARD_ACTION_LABELS[action],
        ...(index === 0 && items.length > 0 ? { separatorBefore: true } : {}),
      });
    }
    if (card.issue)
      items.push({
        id: "open-issue",
        label: card.issue.ticketId
          ? `Open ${featureIssueRef(card.issue)}`
          : `Open issue ${featureIssueRef(card.issue)}`,
        separatorBefore: true,
      });
    items.push({
      id: "issue",
      label: card.issue ? "Change issue…" : "Link issue…",
      ...(card.issue ? {} : { separatorBefore: true }),
    });
    let clicked: MenuId | null = null;
    try {
      clicked = await api.contextMenu.show(items, position);
    } catch {
      return;
    }
    if (clicked === null) return;
    if (clicked === "open") openCard(card);
    else if (clicked === "open-issue") {
      if (card.issue) openFeatureIssue(card, card.issue);
    } else if (clicked === "issue")
      openFeatureIssueDialog({
        environmentId: card.environmentId,
        projectId: card.projectId,
        featureId: card.featureId,
        featureTitle: card.title,
        issue: card.issue,
      });
    else void run(card, clicked);
  };

  return { run, openCard, showMenu };
}
