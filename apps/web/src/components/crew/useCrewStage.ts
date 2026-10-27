import {
  availableCrewActions,
  crewStagePrompt,
  crewStageRefreshKey,
  type CrewAction,
  type CrewStagePrompt,
} from "@t3tools/client-runtime/crew-stage";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { CrewStageSummary, ModelSelection, WorkflowFeatureSnapshot } from "@t3tools/contracts";
import { createContext, useContext, useEffect, useRef } from "react";

import { randomUUID } from "../../lib/utils";
import { featuresEnvironment } from "../../state/features";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";

export interface CrewActionInput {
  /** Gate note, change request, send-back note or Mark done summary. */
  readonly text?: string;
  readonly modelSelection?: ModelSelection;
  /** Send back's target, or where a follow-up from Done starts. */
  readonly stepId?: string;
  /** Mark done's outcome. */
  readonly outcome?: string;
}

export interface CrewStage {
  readonly thread: EnvironmentThreadShell;
  readonly crew: CrewStageSummary;
  readonly snapshot: WorkflowFeatureSnapshot | null;
  readonly actions: ReadonlyArray<CrewAction>;
  /** What this thread's composer banner asks for, if it runs the active stage. */
  readonly prompt: CrewStagePrompt | null;
  readonly run: (action: CrewAction, input?: CrewActionInput) => Promise<boolean>;
}

const EMPTY_ACTIONS: ReadonlyArray<CrewAction> = [];

/**
 * Loads a stage thread's feature only while the thread is open. Nothing streams: the current
 * stage thread's `crew.revision` changes with every decision, and that refreshes the snapshot.
 */
export function useCrewStage(thread: EnvironmentThreadShell | null): CrewStage | null {
  const crew = thread?.crew ?? null;
  const query = useEnvironmentQuery(
    thread && crew
      ? workflowsEnvironment.feature({
          environmentId: thread.environmentId,
          input: { projectId: thread.projectId, featureId: crew.featureId },
        })
      : null,
  );
  const changeKey = crewStageRefreshKey(crew, thread?.latestRun?.status);
  const lastKey = useRef(changeKey);
  const { refresh } = query;
  // oxlint-disable-next-line t3code/react-effect-budget -- Refetches the feature snapshot from the server when the stage's revision or run status moves.
  useEffect(() => {
    if (changeKey === lastKey.current) return;
    lastKey.current = changeKey;
    if (changeKey !== null) refresh();
  }, [changeKey, refresh]);

  const approve = useAtomCommand(featuresEnvironment.approve);
  const requestChanges = useAtomCommand(featuresEnvironment.requestChanges);
  const takeOver = useAtomCommand(featuresEnvironment.takeOver);
  const markDone = useAtomCommand(featuresEnvironment.markDone);
  const sendBack = useAtomCommand(featuresEnvironment.sendBack);
  const skip = useAtomCommand(featuresEnvironment.skip);
  const acceptAsIs = useAtomCommand(featuresEnvironment.acceptAsIs);
  const oneMoreRound = useAtomCommand(featuresEnvironment.oneMoreRound);
  const startNow = useAtomCommand(featuresEnvironment.startNow);
  const reopen = useAtomCommand(featuresEnvironment.reopen);
  const retry = useAtomCommand(workflowsEnvironment.retry);
  const pause = useAtomCommand(workflowsEnvironment.pause);
  const resume = useAtomCommand(workflowsEnvironment.resume);
  const cancel = useAtomCommand(workflowsEnvironment.cancel);

  const environmentId = thread?.environmentId ?? null;
  const projectId = thread?.projectId ?? null;
  const featureId = crew?.featureId ?? null;
  const run = async (action: CrewAction, input: CrewActionInput = {}) => {
    if (!environmentId || !projectId || !featureId) return false;
    const base = { projectId, featureId, requestId: `crew-${action}:${randomUUID()}` };
    const text = input.text?.trim() ? input.text.trim() : undefined;
    const note = text ? { note: text } : {};
    const target = <I>(payload: I) => ({ environmentId, input: payload });
    const result = await (() => {
      switch (action) {
        case "approve":
          return approve(target({ ...base, ...note }));
        case "request-changes":
          return requestChanges(target({ ...base, note: text ?? "" }));
        case "retry":
          return retry(
            target({
              ...base,
              ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
            }),
          );
        case "take-over":
          return takeOver(target(base));
        case "mark-done":
          return markDone(
            target({ ...base, outcome: input.outcome ?? "", summary: text ?? "Done by hand." }),
          );
        case "send-back":
          return sendBack(target({ ...base, stepId: input.stepId ?? "", ...note }));
        case "skip":
          return skip(target(base));
        case "accept-as-is":
          return acceptAsIs(target(base));
        case "one-more-round":
          return oneMoreRound(target(base));
        case "start-now":
          return startNow(target({ projectId, featureId }));
        case "pause":
          return pause(target(base));
        case "resume":
          return resume(target(base));
        case "cancel":
          return cancel(target(base));
        case "reopen":
          return reopen(target({ ...base, ...(input.stepId ? { stepId: input.stepId } : {}) }));
      }
    })();
    if (result._tag !== "Success") return false;
    refresh();
    return true;
  };

  const snapshot = query.data;
  if (!thread || !crew) return null;
  return {
    thread,
    crew,
    snapshot,
    actions: snapshot ? availableCrewActions(snapshot) : EMPTY_ACTIONS,
    prompt: snapshot ? crewStagePrompt(snapshot, thread.id) : null,
    run,
  };
}

export const CrewStageContext = createContext<CrewStage | null>(null);

/** The open stage thread's feature, provided by ChatView. Null in plain threads. */
export function useCrewStageContext(): CrewStage | null {
  return useContext(CrewStageContext);
}
