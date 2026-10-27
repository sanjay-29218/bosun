import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { useNavigation, useNavigationState } from "@react-navigation/native";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import {
  BackHandler,
  Keyboard,
  Pressable,
  type TextInputInstance,
  View,
  type LayoutChangeEvent,
} from "react-native";
import type { MenuAction } from "@react-native-menu/menu";

import { BotAvatar } from "../../components/BotAvatar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { Menu } from "../../components/ui/Menu";
import { SearchField } from "../../components/ui/SearchField";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceListToolbarRow } from "../workspace/WorkspaceListToolbarRow";
import { useWorkspaceConnectionState } from "../../state/workspace";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import {
  threadListViewToggleButton,
  type BotSwitcherMenu,
  type ThreadListViewToggle,
} from "./thread-list-chrome";

export function ThreadListToolbar(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly filterActions: MenuAction[];
  readonly filterCustomized: boolean;
  readonly onFilterAction: NonNullable<ComponentProps<typeof Menu>["onPressAction"]>;
  readonly onOpenEnvironments: () => void;
  readonly botSwitcher: BotSwitcherMenu | null;
  readonly viewToggle: ThreadListViewToggle | null;
  readonly sidebar?: boolean;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
  readonly onRequestVisibility?: () => void;
}) {
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs();
  const isTabActive = workspace?.isTabActive;
  const homeFocused = useNavigationState((state) => state.routes[state.index]?.name === "Home");
  const listFocused =
    homeFocused && (workspace === null || workspace.state.selectedTab === "threads");
  const { paddingTop, paddingBottom } = useToolbarLayout();
  const connectionState = useWorkspaceConnectionState();
  const { onRequestVisibility, onSearchQueryChange } = props;
  const searchRef = useRef<TextInputInstance>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || props.searchQuery.length > 0;
  const openSearch = useCallback(() => {
    onRequestVisibility?.();
    setSearchOpen(true);
    searchRef.current?.focus();
    return true;
  }, [onRequestVisibility]);
  useHardwareKeyboardCommand("focusSearch", openSearch);

  const closeSearch = useCallback(() => {
    onSearchQueryChange("");
    setSearchOpen(false);
    Keyboard.dismiss();
  }, [onSearchQueryChange]);

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

  const filterIcon = props.filterCustomized
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
  const searchField = (
    <SearchField
      inputRef={searchRef}
      accessibilityLabel="Search threads"
      clearAccessibilityLabel="Clear search"
      placeholder="Search"
      value={props.searchQuery}
      onChangeText={onSearchQueryChange}
    />
  );
  const filterButton = connectionState.hasConnections ? (
    <AndroidAnchoredMenu actions={props.filterActions} onPressAction={props.onFilterAction}>
      {(open) => (
        <AndroidHeaderIconButton
          accessibilityLabel="Filter threads"
          icon={filterIcon}
          onPress={open}
        />
      )}
    </AndroidAnchoredMenu>
  ) : null;

  return (
    <View
      onLayout={props.onLayout}
      className={props.sidebar ? "absolute inset-x-0 top-0 z-[4] bg-header px-2" : "bg-header px-2"}
      style={{ paddingTop, paddingBottom }}
    >
      <WorkspaceListToolbarRow
        searching={searching}
        searchField={searchField}
        onCloseSearch={closeSearch}
        onOpenSearch={openSearch}
        searchAccessibilityLabel="Search threads"
        titleAccessibilityLabel="T3 Code, Threads"
        onOpenEnvironments={props.onOpenEnvironments}
        actions={
          <>
            {props.botSwitcher ? <BotSwitcherButton menu={props.botSwitcher} /> : null}
            {props.viewToggle ? (
              <AndroidHeaderIconButton
                {...threadListViewToggleButton(props.viewToggle.view)}
                onPress={props.viewToggle.onToggle}
              />
            ) : null}
          </>
        }
        filter={filterButton}
      />
    </View>
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
