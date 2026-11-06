import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";

import type { AppBarMenuItem } from "../../../components/ui/AppBar.types";
import {
  threadListViewToggleButton,
  type BotSwitcherMenu,
  type ThreadListViewToggle,
} from "../../home/thread-list-chrome";
import { withNativeGlassHeaderItem } from "../native-glass-header-items";

type NativeHeaderMenuItems = NativeStackHeaderItemMenu["menu"]["items"];
type NativeHeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;

function sfSymbolIcon(name: string): NativeHeaderIcon {
  return { type: "sfSymbol", name: name as never };
}

function toNativeHeaderMenuItems(items: ReadonlyArray<AppBarMenuItem>): NativeHeaderMenuItems {
  return items.map((item) =>
    "items" in item
      ? {
          type: "submenu" as const,
          label: item.title ?? "",
          items: toNativeHeaderMenuItems(item.items),
        }
      : {
          type: "action" as const,
          label: item.title,
          description: item.subtitle,
          onPress: item.onPress,
          state: item.selected ? ("on" as const) : undefined,
        },
  );
}

/**
 * The bot switcher (the active bot's name, badged on iOS 26 with what waits on you under the
 * other bots) and the List / Board toggle.
 */
function createThreadListHeaderItems(input: {
  readonly botSwitcher?: BotSwitcherMenu | null;
  readonly viewToggle?: ThreadListViewToggle | null;
}): NativeStackHeaderItem[] {
  const { botSwitcher, viewToggle } = input;
  const toggle = viewToggle ? threadListViewToggleButton(viewToggle.view) : null;
  return [
    ...(botSwitcher
      ? [
          withNativeGlassHeaderItem({
            type: "menu",
            label: botSwitcher.name,
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

/** The sidebar column's bar items, as native header items so the title can size around them. */
export function createWorkspaceListHeaderItems(input: {
  readonly filter: {
    readonly accessibilityLabel: string;
    readonly icon: string;
    readonly title: string;
    readonly items: ReadonlyArray<AppBarMenuItem>;
  };
  readonly onOpenSettings?: () => void;
  readonly botSwitcher?: BotSwitcherMenu | null;
  readonly viewToggle?: ThreadListViewToggle | null;
}): NativeStackHeaderItem[] {
  return [
    ...createThreadListHeaderItems(input),
    withNativeGlassHeaderItem({
      type: "menu",
      axisBehavior: "horizontalOnly",
      label: "",
      accessibilityLabel: input.filter.accessibilityLabel,
      icon: sfSymbolIcon(input.filter.icon),
      menu: {
        title: input.filter.title,
        items: toNativeHeaderMenuItems(input.filter.items),
      },
    }),
    ...(input.onOpenSettings
      ? [
          withNativeGlassHeaderItem({
            type: "button",
            axisBehavior: "horizontalOnly",
            label: "Settings",
            accessibilityLabel: "Open settings",
            icon: sfSymbolIcon("gearshape"),
            onPress: input.onOpenSettings,
          }),
        ]
      : []),
  ];
}
