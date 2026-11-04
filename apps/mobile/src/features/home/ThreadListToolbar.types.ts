import type { MenuAction } from "@react-native-menu/menu";

import type { BotSwitcherMenu, ThreadListViewToggle } from "./thread-list-chrome";

export interface ThreadListToolbarProps {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly filterActions: MenuAction[];
  readonly filterCustomized: boolean;
  readonly onFilterSelect: (id: string) => void;
  readonly onOpenEnvironments: () => void;
  readonly botSwitcher: BotSwitcherMenu | null;
  readonly viewToggle: ThreadListViewToggle | null;
  readonly onRequestVisibility?: () => void;
}
