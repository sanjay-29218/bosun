import { collectNeedsYou, oldestNeedsYouItem } from "@t3tools/client-runtime/state/crew-board";
import type { useNavigate } from "@tanstack/react-router";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { needsYouThreadsAtom } from "../../state/needsYou";
import { toastManager } from "../ui/toast";

/**
 * ⌘⇧Y: opens the thread that has waited on you longest, from anywhere. It reads the shells
 * every client already has, so it needs no request.
 */
export function openNextNeedsYou(navigate: ReturnType<typeof useNavigate>): void {
  const shells = appAtomRegistry.get(needsYouThreadsAtom);
  const oldest = oldestNeedsYouItem(collectNeedsYou({ cards: [], shells }));
  if (oldest?.type !== "thread") {
    toastManager.add({ id: "needs-you-next", title: "Nothing needs you", timeout: 1500 });
    return;
  }
  void navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: oldest.shell.environmentId, threadId: oldest.shell.id },
  });
}
