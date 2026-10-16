import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useEnvironmentFilter } from "../../state/botRail";
import { botsEnvironment } from "../../state/bots";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { toastManager } from "../ui/toast";

/**
 * Opens a bot's headquarters: the one thread where it sees all its projects. The server
 * creates it on first use, on the first connected, shown environment that has the bot.
 */
/** The bot on the first connected environment the sidebar shows, whose headquarters opens. */
export function headquartersMember(
  bot: LogicalBot,
  connected: ReadonlyArray<string>,
  environmentFilter: ReadonlySet<string> | null,
) {
  return bot.members.find(
    (candidate) =>
      connected.includes(candidate.environmentId) &&
      (environmentFilter === null || environmentFilter.has(candidate.environmentId)),
  );
}

export function useOpenBotHeadquarters() {
  const navigate = useNavigate();
  const connected = useConnectedEnvironmentIds();
  const environmentFilter = useEnvironmentFilter();
  const open = useAtomCommand(botsEnvironment.openHeadquarters, { reportFailure: false });
  return useCallback(
    (bot: LogicalBot) => {
      const member = headquartersMember(bot, connected, environmentFilter);
      if (!member) return;
      void open({ environmentId: member.environmentId, input: { botId: member.botId } }).then(
        (result) => {
          if (result._tag === "Success") {
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(member.environmentId, result.value.threadId),
              ),
            });
          } else {
            toastManager.add({
              type: "error",
              title: `Could not open ${bot.name}`,
              description: formatEnvironmentQueryError(result.cause),
            });
          }
        },
      );
    },
    [connected, environmentFilter, navigate, open],
  );
}
