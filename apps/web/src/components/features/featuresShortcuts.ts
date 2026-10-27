import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

const FEATURES_PAGE_COMMANDS = ["features.workflow", "features.needsYou"] as const;
export type FeaturesPageCommand = (typeof FEATURES_PAGE_COMMANDS)[number];

/** Resolves board shortcuts without taking letters from fields or popup controls. */
export function resolveFeaturesShortcut(
  event: ShortcutEventLike & { target: EventTarget | null },
  keybindings: ResolvedKeybindingsConfig,
): FeaturesPageCommand | null {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]'))
  ) {
    return null;
  }
  const command = resolveShortcutCommand(event, keybindings, {
    context: { featuresPageOpen: true },
  });
  return FEATURES_PAGE_COMMANDS.find((candidate) => candidate === command) ?? null;
}
