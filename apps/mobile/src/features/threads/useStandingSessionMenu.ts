import {
  type EnvironmentId,
  headquartersBotId,
  isStandingThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import type { AppBarMenu } from "../../components/ui/AppBar.types";
import * as Dialog from "../../components/ui/Dialog";
import { botsEnvironment } from "../../state/bots";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Start new session for a standing thread: a bot's headquarters or a project's manager. Null for
 * every other thread.
 */
export function useStandingSessionMenu(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly name: string;
  } | null,
): AppBarMenu | null {
  const startBot = useAtomCommand(botsEnvironment.startNewSession, { reportFailure: false });
  const startStanding = useAtomCommand(rolesEnvironment.startNewSession, { reportFailure: false });
  if (thread === null || !isStandingThread(thread.id)) return null;
  const botId = headquartersBotId(thread.id);
  const confirm = () =>
    Dialog.confirm({
      title: `Start a new session for ${thread.name}?`,
      message:
        "You keep the whole conversation. It starts again from its instructions and the last few messages.",
      confirmText: "Start",
      onConfirm: () => {
        const report = (result: { readonly _tag: string; readonly cause?: unknown }) => {
          if (result._tag === "Success") return;
          const error = Cause.squash(result.cause as Cause.Cause<unknown>);
          Dialog.alert(
            "Could not start a new session",
            error instanceof Error ? error.message : "Try again when it finishes.",
          );
        };
        // A bot's headquarters keeps its own command, which servers before project managers have.
        if (botId === null) {
          void startStanding({
            environmentId: thread.environmentId,
            input: { threadId: thread.id },
          }).then(report);
        } else {
          void startBot({ environmentId: thread.environmentId, input: { botId } }).then(report);
        }
      },
    });
  return {
    title: "Session",
    icon: "arrow.clockwise",
    items: [
      { id: "new-session", title: "Start new session", icon: "arrow.clockwise", onPress: confirm },
    ],
  };
}
