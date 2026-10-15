import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import { useCallback } from "react";
import { Alert } from "react-native";

import { botsEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Opens a bot's headquarters, which the server creates on first use, through the screen's own
 * `selectThread`.
 */
export function useOpenBotHeadquarters(
  selectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void,
) {
  const open = useAtomCommand(botsEnvironment.openHeadquarters);
  return useCallback(
    async (bot: LogicalBot) => {
      const member = bot.members[0];
      if (!member) return;
      const result = await open({
        environmentId: member.environmentId,
        input: { botId: member.botId },
      });
      if (result._tag === "Success") {
        selectThread({ environmentId: member.environmentId, id: result.value.threadId });
      } else {
        Alert.alert(`Could not open ${bot.name}`, Cause.pretty(result.cause));
      }
    },
    [open, selectThread],
  );
}
