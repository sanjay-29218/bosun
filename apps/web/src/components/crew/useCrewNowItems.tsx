import { formatStageName } from "@t3tools/client-runtime/crew-stage";
import type { ThreadId } from "@t3tools/contracts";
import { FlagIcon, HandIcon, ShieldQuestionIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import type { ThreadNowItem } from "../chat/ThreadNow";
import { InlineButton } from "../ui/button";
import type { CrewStage } from "./useCrewStage";

/**
 * A crew thread's end-of-timeline line: what a stage elsewhere asks of you. Same shape as a
 * subagent's question.
 */
export function useCrewNowItems(input: {
  readonly stage: CrewStage | null;
  readonly canOperate: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ThreadNowItem | null {
  const { stage, canOperate, onOpenThread } = input;
  const [busy, setBusy] = useState(false);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    await run();
    setBusy(false);
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
          disabled={!canOperate || busy}
          onClick={() => void act(() => stage.run(action))}
        >
          {busy ? pending : label}
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

  return attention;
}
