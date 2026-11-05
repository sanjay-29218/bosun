import {
  isAtomCommandInterrupted,
  runAtomCommand,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { headquartersBotId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";

import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { botsEnvironment } from "../../state/bots";
import { rolesEnvironment } from "../../state/roles";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Starts a standing thread, a bot's headquarters or a project's manager, over in a new session,
 * for a thread menu, the composer or the command palette.
 */
export async function startStandingNewSession(
  environmentId: EnvironmentId,
  thread: { readonly threadId: ThreadId; readonly name: string },
): Promise<void> {
  const api = readLocalApi();
  if (!api) return;
  const confirmed = await settlePromise(() =>
    api.dialogs.confirm(
      [
        `Start a new session for ${thread.name}?`,
        "You keep the whole conversation. It starts again from its instructions and the last few messages.",
      ].join("\n"),
    ),
  );
  if (confirmed._tag === "Failure" || !confirmed.value) return;
  const botId = headquartersBotId(thread.threadId);
  // A bot's headquarters keeps its own command, which servers before project managers have.
  const result = await (botId === null
    ? runAtomCommand(
        appAtomRegistry,
        rolesEnvironment.startNewSession,
        { environmentId, input: { threadId: thread.threadId } },
        { reportFailure: false },
      )
    : runAtomCommand(
        appAtomRegistry,
        botsEnvironment.startNewSession,
        { environmentId, input: { botId } },
        { reportFailure: false },
      ));
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
