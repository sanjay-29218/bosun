import {
  isAtomCommandInterrupted,
  runAtomCommand,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { botsEnvironment } from "../../state/bots";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Starts a bot's headquarters over in a new session, for a thread menu or the command palette. */
export async function startBotNewSession(
  environmentId: EnvironmentId,
  bot: { readonly id: string; readonly name: string },
): Promise<void> {
  const api = readLocalApi();
  if (!api) return;
  const confirmed = await settlePromise(() =>
    api.dialogs.confirm(
      [
        `Start a new session for ${bot.name}?`,
        "You keep the whole conversation. The bot starts again from its instructions and the last few messages.",
      ].join("\n"),
    ),
  );
  if (confirmed._tag === "Failure" || !confirmed.value) return;
  const result = await runAtomCommand(
    appAtomRegistry,
    botsEnvironment.startNewSession,
    { environmentId, input: { botId: bot.id } },
    { reportFailure: false },
  );
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not start a new session",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}
