import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";

import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import {
  threadListViewToggleButton,
  type BotSwitcherMenu,
  type ThreadListViewToggle,
} from "../home/thread-list-chrome";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

type NativeHeaderMenuItems = NativeStackHeaderItemMenu["menu"]["items"];
type NativeHeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;

function sfSymbolIcon(name: string): NativeHeaderIcon {
  return { type: "sfSymbol", name: name as never };
}

function toNativeHeaderMenuItems(items: HomeListFilterMenu["items"]): NativeHeaderMenuItems {
  return items.map((item) =>
    item.type === "action"
      ? {
          type: "action" as const,
          label: item.title,
          description: item.subtitle,
          onPress: item.onPress,
          state: item.state === "on" ? ("on" as const) : undefined,
        }
      : {
          type: "submenu" as const,
          label: item.title,
          items: toNativeHeaderMenuItems(item.items),
        },
  );
}

/**
 * The bot switcher (the active bot's emoji, badged on iOS 26 with what waits on you under the
 * other bots) and the List / Board toggle, for any thread-list header.
 */
export function createThreadListHeaderItems(input: {
  readonly botSwitcher: BotSwitcherMenu | null;
  readonly viewToggle: ThreadListViewToggle | null;
}): NativeStackHeaderItem[] {
  const { botSwitcher, viewToggle } = input;
  const toggle = viewToggle ? threadListViewToggleButton(viewToggle.view) : null;
  return [
    ...(botSwitcher
      ? [
          withNativeGlassHeaderItem({
            type: "menu",
            label: botSwitcher.emoji,
            accessibilityLabel: botSwitcher.accessibilityLabel,
            ...(botSwitcher.elsewhereNeedsYou > 0
              ? { badge: { value: botSwitcher.elsewhereNeedsYou } }
              : {}),
            menu: {
              title: "Bots",
              items: botSwitcher.items.map((item) => ({
                type: "action" as const,
                label: item.title,
                description: item.subtitle,
                onPress: item.onPress,
                state: item.state === "on" ? ("on" as const) : undefined,
              })),
            },
          }),
        ]
      : []),
    ...(viewToggle && toggle
      ? [
          withNativeGlassHeaderItem({
            type: "button",
            label: "",
            accessibilityLabel: toggle.accessibilityLabel,
            icon: sfSymbolIcon(toggle.icon),
            onPress: viewToggle.onToggle,
          }),
        ]
      : []),
  ];
}

/**
 * Right-side UINavigationBar items for the sidebar column: the thread list
 * filter/sort menu plus the settings button, sharing one glass capsule —
 * the Messages-style grouped header buttons.
 */
export function createSidebarHeaderItems(input: {
  readonly filterIcon: string;
  readonly filterMenu: HomeListFilterMenu;
  readonly onOpenSettings: () => void;
  readonly botSwitcher: BotSwitcherMenu | null;
  readonly viewToggle: ThreadListViewToggle | null;
}): NativeStackHeaderItem[] {
  return [
    ...createThreadListHeaderItems(input),
    withNativeGlassHeaderItem({
      type: "menu",
      label: "",
      accessibilityLabel: "Filter threads",
      icon: sfSymbolIcon(input.filterIcon),
      menu: {
        title: input.filterMenu.title,
        items: toNativeHeaderMenuItems(input.filterMenu.items),
      },
    }),
    withNativeGlassHeaderItem({
      type: "button",
      label: "",
      accessibilityLabel: "Open settings",
      icon: sfSymbolIcon("gearshape"),
      onPress: input.onOpenSettings,
    }),
  ];
}
