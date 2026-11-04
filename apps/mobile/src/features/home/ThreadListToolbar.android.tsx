import { useEffect, useState } from "react";
import { useNavigation, useNavigationState } from "@react-navigation/native";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { BackHandler, Keyboard, Pressable } from "react-native";

import { BotAvatar } from "../../components/BotAvatar";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { appBarMenuItemsFromActions } from "../../components/ui/menuActionItems";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceBrandTitle } from "../workspace/WorkspaceBrandTitle";
import { useWorkspaceConnectionState } from "../../state/workspace";
import type { ThreadListToolbarProps } from "./ThreadListToolbar.types";
import { threadListViewToggleButton, type BotSwitcherMenu } from "./thread-list-chrome";

export function ThreadListToolbar(props: ThreadListToolbarProps) {
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs();
  const isTabActive = workspace?.isTabActive;
  const homeFocused = useNavigationState((state) => state.routes[state.index]?.name === "Home");
  const listFocused =
    homeFocused && (workspace === null || workspace.state.selectedTab === "threads");
  const connectionState = useWorkspaceConnectionState();
  const { onRequestVisibility, onSearchQueryChange } = props;
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || props.searchQuery.length > 0;
  const openSearch = () => {
    onRequestVisibility?.();
    setSearchOpen(true);
    return true;
  };
  useHardwareKeyboardCommand("focusSearch", openSearch);

  const closeSearch = () => {
    onSearchQueryChange("");
    setSearchOpen(false);
    Keyboard.dismiss();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to BackHandler while searching to close search on Android back
  useEffect(() => {
    if (!searching || !listFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens can keep effects alive after a detail route opens.
      const state = navigation.getState();
      if (
        !state ||
        state.routes[state.index]?.name !== "Home" ||
        isTabActive?.("threads") === false
      )
        return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [closeSearch, searching, listFocused, navigation, isTabActive]);

  return (
    <AppBar
      title="T3 Code"
      titleContent={
        <WorkspaceBrandTitle
          accessibilityLabel="T3 Code, Threads"
          onOpenEnvironments={props.onOpenEnvironments}
        />
      }
      search={{
        value: props.searchQuery,
        onChangeText: onSearchQueryChange,
        placeholder: "Search",
        accessibilityLabel: "Search threads",
        active: searching,
        onOpen: openSearch,
        onClose: closeSearch,
      }}
      actions={
        props.viewToggle
          ? [
              {
                ...threadListViewToggleButton(props.viewToggle.view),
                onPress: props.viewToggle.onToggle,
              },
            ]
          : undefined
      }
      trailing={props.botSwitcher ? <BotSwitcherButton menu={props.botSwitcher} /> : undefined}
      menus={
        connectionState.hasConnections
          ? [
              {
                title: "Filter threads",
                icon: props.filterCustomized
                  ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease.circle",
                items: appBarMenuItemsFromActions(props.filterActions, props.onFilterSelect),
              },
            ]
          : undefined
      }
    />
  );
}

/** The active bot's avatar in an icon-button slot; the menu lists every bot and what waits. */
function BotSwitcherButton(props: { readonly menu: BotSwitcherMenu }) {
  const { menu } = props;
  const { buttonSize, iconSize } = useAndroidControlSizing();
  return (
    <AndroidAnchoredMenu
      title="Bots"
      actions={menu.items.map((item) => ({
        id: item.key,
        title: item.title,
        ...(item.subtitle ? { subtitle: item.subtitle } : {}),
        ...(item.state ? { state: item.state } : {}),
      }))}
      onPressAction={({ nativeEvent }) =>
        menu.items.find((item) => item.key === nativeEvent.event)?.onPress()
      }
    >
      {(open) => (
        <Pressable
          accessibilityLabel={menu.accessibilityLabel}
          accessibilityRole="button"
          className="items-center justify-center"
          style={{ width: buttonSize, height: buttonSize }}
          onPress={open}
        >
          {menu.bot ? (
            <BotAvatar avatar={menu.bot.avatar} color={menu.bot.color} size={iconSize + 10} />
          ) : (
            <SymbolView
              name="tray"
              size={iconSize}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          )}
        </Pressable>
      )}
    </AndroidAnchoredMenu>
  );
}
