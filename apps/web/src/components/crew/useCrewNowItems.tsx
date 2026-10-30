import { formatStageName } from "@t3tools/client-runtime/crew-stage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ThreadId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  CircleDashedIcon,
  FlagIcon,
  HandIcon,
  MessageCircleIcon,
  ShieldQuestionIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { tickTextContent } from "~/lib/tickTextContent";
import { useCrewHandoffWait } from "../../state/entities";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ThreadNowItem } from "../chat/ThreadNow";
import { InlineButton } from "../ui/button";
import type { CrewStage } from "./useCrewStage";

/**
 * A crew thread's end-of-timeline lines: what a stage elsewhere asks of you, and the crew
 * members it handed work to. Same shapes as a subagent's question and background work.
 */
export function useCrewNowItems(input: {
  readonly thread: EnvironmentThreadShell | null;
  readonly stage: CrewStage | null;
  readonly canOperate: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): { readonly attention: ThreadNowItem | null; readonly work: ThreadNowItem | null } {
  const { thread, stage, canOperate, onOpenThread } = input;
  const [busy, setBusy] = useState<"stage" | "handoffs" | null>(null);
  const wait = useCrewHandoffWait(thread ? scopeThreadRef(thread.environmentId, thread.id) : null);
  const cancel = useAtomCommand(rolesEnvironment.cancel);
  const retry = useAtomCommand(rolesEnvironment.retry);

  const act = async (line: "stage" | "handoffs", run: () => Promise<unknown>) => {
    setBusy(line);
    await run();
    setBusy(null);
  };

  const waiting = stage && !stage.prompt ? stage.waiting : null;
  const attention = ((): ThreadNowItem | null => {
    if (!waiting) return null;
    const { prompt, threadId } = waiting;
    const name = formatStageName(prompt.stepId);
    const open = (
      <InlineButton tone="muted" onClick={() => onOpenThread(threadId)}>
        Open {name}
      </InlineButton>
    );
    const stageAction = (action: "approve" | "retry", label: string, pending: string) =>
      stage?.actions.includes(action) ? (
        <InlineButton
          disabled={!canOperate || busy !== null}
          onClick={() => void act("stage", () => stage.run(action))}
        >
          {busy === "stage" ? pending : label}
        </InlineButton>
      ) : null;
    const base = { id: `crew-stage:${prompt.stepId}` };
    switch (prompt.kind) {
      case "gate":
        return {
          ...base,
          icon: <ShieldQuestionIcon className="text-info-foreground" />,
          title: `${name} waits for your approval`,
          description: prompt.summary,
          actions: (
            <>
              {open}
              {stageAction("approve", "Approve", "Approving...")}
            </>
          ),
        };
      case "failure":
        return {
          ...base,
          icon: <TriangleAlertIcon className="text-destructive-foreground" />,
          title: `${name} failed · attempt ${prompt.attempt}`,
          description: prompt.error,
          actions: (
            <>
              {open}
              {stageAction("retry", "Retry", "Retrying...")}
            </>
          ),
        };
      case "your-call":
        return {
          ...base,
          icon: <FlagIcon className="text-info-foreground" />,
          title: `${name} reached its ${prompt.reason === "loop-limit" ? "loop" : "stage"} limit`,
          description: `Next would be ${formatStageName(prompt.target)}. It's your call.`,
          actions: open,
        };
      case "taken-over":
        return { ...base, icon: <HandIcon />, title: `You're driving ${name}`, actions: open };
    }
  })();

  const work = ((): ThreadNowItem | null => {
    if (!thread || !wait) return null;
    const target = { environmentId: thread.environmentId };
    const projectId = thread.projectId;
    const startedAtMs = wait.startedAt === null ? null : Date.parse(wait.startedAt);
    // Open goes where the work is held up: the end of the chain, else the member itself.
    const openThreadId = wait.blockedBy?.threadId ?? wait.threadId;
    const shown = wait.blockedBy?.kind ?? wait.kind;
    return {
      id: `crew-handoffs:${thread.id}`,
      icon:
        shown === "failed" ? (
          <TriangleAlertIcon className="text-destructive-foreground" />
        ) : shown === "question" ? (
          <MessageCircleIcon />
        ) : (
          <CircleDashedIcon />
        ),
      title: wait.title,
      description: wait.detail,
      actions: (
        <>
          {startedAtMs === null ? null : (
            <span
              ref={tickTextContent(
                (nowMs) => formatDuration(Math.max(1_000, nowMs - startedAtMs)),
                true,
              )}
              className="tabular-nums"
            />
          )}
          {openThreadId === null ? null : (
            <InlineButton tone="muted" onClick={() => onOpenThread(openThreadId)}>
              {wait.blockedBy ? `Open ${wait.blockedBy.member}` : "Open"}
            </InlineButton>
          )}
          {wait.kind === "failed" ? (
            <InlineButton
              disabled={!canOperate || busy !== null}
              onClick={() =>
                void act("handoffs", () =>
                  retry({ ...target, input: { projectId, requestId: wait.handoffIds[0]! } }),
                )
              }
            >
              {busy === "handoffs" ? "Retrying..." : "Retry"}
            </InlineButton>
          ) : (
            <InlineButton
              disabled={!canOperate || busy !== null}
              onClick={() =>
                void act("handoffs", () =>
                  Promise.all(
                    wait.handoffIds.map((requestId) =>
                      cancel({ ...target, input: { projectId, requestId } }),
                    ),
                  ),
                )
              }
            >
              {busy === "handoffs" ? "Stopping..." : "Stop"}
            </InlineButton>
          )}
        </>
      ),
    };
  })();

  return { attention, work };
}
