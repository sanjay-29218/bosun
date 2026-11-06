import type { AppBarMenuItem } from "../../../components/ui/AppBar.types";
import type { BotSwitcherMenu, ThreadListViewToggle } from "../../home/thread-list-chrome";

/** The header of the workspace thread list, on Home and in the sidebar column. */
export interface WorkspaceListHeaderProps {
  /** Spoken for the brand title, such as "T3 Code, Threads". */
  readonly accessibilityLabel: string;
  /** The connection status beside the brand opens environment settings. */
  readonly onOpenEnvironments: () => void;
  readonly search: {
    readonly value: string;
    readonly onChangeText: (value: string) => void;
    readonly placeholder: string;
    readonly accessibilityLabel: string;
  };
  readonly filter: {
    readonly customized: boolean;
    readonly items: ReadonlyArray<AppBarMenuItem>;
  };
  /** Null with fewer than two bots. */
  readonly botSwitcher?: BotSwitcherMenu | null;
  /** Null when no connected environment runs features and the list shows threads. */
  readonly viewToggle?: ThreadListViewToggle | null;
  /** iOS: a settings button. Android reaches Settings from the workspace navigation. */
  readonly onOpenSettings?: () => void;
  /**
   * Set when the list is the workspace's sidebar column, which draws its own bar on iOS. Without
   * it the iOS workspace root's toolbar draws the list's bar and search.
   */
  readonly sidebar?: {
    readonly width: number;
    readonly visible: boolean;
    readonly onRequestVisibility: () => void;
  };
}

export function workspaceListFilterIcon(customized: boolean) {
  return customized
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
}
