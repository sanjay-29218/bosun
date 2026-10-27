import { SymbolView } from "../../components/ui/AppSymbol";
import { BotAvatar } from "../../components/BotAvatar";
import { Menu } from "../../components/ui/Menu";
import { Pressable, View } from "react-native";

import {
  threadListViewToggleButton,
  type BotSwitcherMenu,
  type ThreadListViewToggle,
} from "../home/thread-list-chrome";

export interface SidebarHeaderActionsProps {
  readonly onOpenSettings: () => void;
  readonly botSwitcher?: BotSwitcherMenu | null;
  readonly viewToggle?: ThreadListViewToggle | null;
}

function FallbackHeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: "gearshape" | "square.and.pencil" | "square.split.2x1" | "list.bullet";
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      className="size-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={18}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
    </Pressable>
  );
}

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  const { botSwitcher, viewToggle } = props;
  return (
    <View className="flex-row items-center gap-0.5">
      {botSwitcher ? (
        <Menu
          accessibilityLabel={botSwitcher.accessibilityLabel}
          title="Bots"
          actions={botSwitcher.items.map((item) => ({
            id: item.key,
            title: item.title,
            ...(item.subtitle ? { subtitle: item.subtitle } : {}),
            ...(item.state ? { state: item.state } : {}),
          }))}
          onPressAction={({ nativeEvent }) =>
            botSwitcher.items.find((item) => item.key === nativeEvent.event)?.onPress()
          }
        >
          <View className="size-11 items-center justify-center rounded-full bg-subtle">
            {botSwitcher.bot ? (
              <BotAvatar avatar={botSwitcher.bot.avatar} color={botSwitcher.bot.color} size={34} />
            ) : (
              <SymbolView
                name="tray"
                size={20}
                tintColorClassName="accent-foreground"
                type="monochrome"
              />
            )}
          </View>
        </Menu>
      ) : null}
      {viewToggle ? (
        <FallbackHeaderButton
          {...threadListViewToggleButton(viewToggle.view)}
          onPress={viewToggle.onToggle}
        />
      ) : null}
      <FallbackHeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
