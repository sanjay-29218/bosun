import { threadNeedsYouKind } from "@t3tools/client-runtime/state/crew-board";
import { hasUnseenCompletion, isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";

import { useThreadShell } from "../../state/entities";

/** A standing thread's state, and its label for screen readers. */
export function useStandingStatus(ref: Parameters<typeof useThreadShell>[0]) {
  const shell = useThreadShell(ref);
  const waiting = shell !== null && threadNeedsYouKind(shell) !== null;
  const working = shell !== null && !waiting && isThreadWorking(shell);
  // A server without visit tracking never reads as unseen.
  const done =
    shell !== null &&
    !waiting &&
    !working &&
    shell.lastVisitedAt !== undefined &&
    hasUnseenCompletion(shell);
  return {
    waiting,
    working,
    done,
    status: waiting ? "needs you" : working ? "working" : done ? "done" : null,
  };
}
