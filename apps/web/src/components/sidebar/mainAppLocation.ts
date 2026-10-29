import { useLocation, useNavigate, useRouter, type AnyRouter } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { GUEST_PAGE_PATH } from "../../guestPage";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { readActiveLogicalBotKey } from "../../state/botRail";
import { readActiveEnvironmentId } from "../../state/entities";

/** Settings and Usage open as modals over the last main-app view. */
export function isAppModalPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/usage";
}

export const AUTOMATIONS_PATH = "/automations";
export const LIBRARY_PATH = "/library";
export const BOTS_PATH = "/bots";

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname.startsWith("/projects/") ||
    pathname === "/pull-requests" ||
    pathname === AUTOMATIONS_PATH ||
    pathname === LIBRARY_PATH ||
    pathname === BOTS_PATH
  );
}

/**
 * What the rail points at: the bots (each bot's or All bots' threads) or one of its places,
 * where `bot-list` is the Bots place that adds and edits them. The sidebar column shows the
 * destination's list.
 */
export type RailDestination = "bots" | "bot-list" | "automations" | "library" | "pull-requests";

const railDestinationForPathname = (pathname: string): RailDestination =>
  pathname === BOTS_PATH
    ? "bot-list"
    : pathname === AUTOMATIONS_PATH
      ? "automations"
      : pathname === LIBRARY_PATH
        ? "library"
        : pathname === "/pull-requests"
          ? "pull-requests"
          : "bots";

/** The route's destination. Settings and Usage open over it, so they keep the one underneath. */
export function useRailDestination(): RailDestination {
  const routeDestination = useLocation({
    select: (location) =>
      isAppModalPage(location.pathname) ? null : railDestinationForPathname(location.pathname),
  });
  const [destination, setDestination] = useState<RailDestination>(routeDestination ?? "bots");
  if (routeDestination !== null && routeDestination !== destination) {
    setDestination(routeDestination);
  }
  return routeDestination ?? destination;
}

// Neither List nor Board: a modal or a utility page is showing.
const isOutsideMainView = (pathname: string) =>
  isAppModalPage(pathname) || isSidebarUtilityPage(pathname);

/**
 * The main app has two views, flipped by the sidebar's List / Board toggle: List is the
 * thread view, Board the feature board. The route decides which one shows, so a board
 * link opens the board and opening a thread from it is List again.
 */
export type MainView = "list" | "board";
export const BOARD_PATH = "/board";

export const mainViewForPathname = (pathname: string): MainView =>
  pathname === BOARD_PATH ? "board" : "list";

/** What `board.toggle` shows: List from the board, the board from anywhere else. */
export const toggledMainView = (current: MainView | null): MainView =>
  current === "board" ? "list" : "board";

// Pages the root route always renders without the app shell, so they are never
// a page to return to. Other paths seen before auth or on a prompt-link landing
// are still recorded; they are real app URLs, so returning to one is harmless.
const SHELL_LESS_PATHS = new Set(["/pair", "/connect", "/connect-agent", GUEST_PAGE_PATH]);

let mainAppHref: string | null = null;
let appModalReturnHref: string | null = null;
// Where each view was left, so the toggle flips back to the same thread or board scope.
const mainViewHrefs: Record<MainView, string | null> = { list: null, board: null };

const MAIN_VIEW_STORAGE_KEY = "t3code:main-view:v1";
const MainViewsSchema = Schema.Record(Schema.String, Schema.Literals(["list", "board"]));

function readMainViews(): Record<string, MainView> {
  try {
    return getLocalStorageItem(MAIN_VIEW_STORAGE_KEY, MainViewsSchema) ?? {};
  } catch {
    return {};
  }
}

// Each bot remembers its view; All bots, or a rail that knows no bot yet, uses the environment.
function mainViewKey(environmentId: EnvironmentId | null): string | null {
  const botKey = readActiveLogicalBotKey();
  return botKey === null ? environmentId : `bot:${botKey}`;
}

/** The view the active bot last showed. Opening the app at `/` lands there. */
export function readMainView(environmentId: EnvironmentId | null): MainView {
  const key = mainViewKey(environmentId);
  return (key && readMainViews()[key]) || "list";
}

function rememberMainView(environmentId: EnvironmentId | null, view: MainView) {
  const key = mainViewKey(environmentId);
  if (key === null) return;
  const views = readMainViews();
  if (views[key] === view) return;
  try {
    setLocalStorageItem(MAIN_VIEW_STORAGE_KEY, { ...views, [key]: view }, MainViewsSchema);
  } catch (error) {
    console.error("Could not save the main view.", error);
  }
}

/**
 * Remembers where Settings, Usage, and the utility pages lead back to, and the main view
 * each location shows so the List / Board toggle and the next launch return to it.
 */
export function startMainAppLocationTracking(router: AnyRouter): () => void {
  const record = () => {
    const { pathname, href } = router.state.location;
    if (isAppModalPage(pathname) || SHELL_LESS_PATHS.has(pathname)) return;
    appModalReturnHref = href;
    if (isSidebarUtilityPage(pathname)) return;
    mainAppHref = href;
    // The index only forwards to a draft or the board, so it is neither view.
    if (pathname === "/") return;
    const view = mainViewForPathname(pathname);
    mainViewHrefs[view] = href;
    rememberMainView(readActiveEnvironmentId(), view);
  };
  record();
  return router.subscribe("onResolved", record);
}

// Leaves a utility page for the last main app URL, or the thread list when
// the app was opened directly on a utility page.
export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}

/** Leaves Settings or Usage for the page that opened it. */
export function useCloseAppModal() {
  const navigate = useNavigate();
  return () => navigate({ href: appModalReturnHref ?? mainAppHref ?? "/" });
}

/**
 * Shows a main view where it was left. Remembered before navigating, so List's
 * fallback to `/` lands on a draft instead of bouncing back to the board.
 */
export function useShowMainView() {
  const navigate = useNavigate();
  return (view: MainView, options?: { readonly replace?: boolean }) => {
    rememberMainView(readActiveEnvironmentId(), view);
    return navigate({
      href: mainViewHrefs[view] ?? (view === "board" ? BOARD_PATH : "/"),
      replace: options?.replace ?? false,
    });
  };
}

/** `board.toggle`: flips between the views from wherever the app is when it runs. */
export function useToggleMainView() {
  const router = useRouter();
  const showMainView = useShowMainView();
  return () => {
    const { pathname } = router.state.location;
    return showMainView(
      toggledMainView(isOutsideMainView(pathname) ? null : mainViewForPathname(pathname)),
    );
  };
}

/**
 * Switches bots through `select`, keeping List / Board per bot: the view on screen is saved
 * for the bot being left, then the new bot's saved view shows. A bot without one keeps the
 * current view and saves it. From a utility page it opens the new bot's view.
 */
export function useSwitchBotMainView() {
  const router = useRouter();
  const showMainView = useShowMainView();
  return (select: () => void) => {
    const { pathname } = router.state.location;
    const utility = isOutsideMainView(pathname);
    const current = pathname === "/" || utility ? null : mainViewForPathname(pathname);
    if (current) rememberMainView(readActiveEnvironmentId(), current);
    select();
    // From Settings, Usage and the utility pages, picking a bot opens its list or board.
    if (utility) {
      const key = mainViewKey(readActiveEnvironmentId());
      void showMainView((key === null ? undefined : readMainViews()[key]) ?? "list");
      return;
    }
    if (!current) return;
    const key = mainViewKey(readActiveEnvironmentId());
    const remembered = key === null ? undefined : readMainViews()[key];
    if (!remembered) rememberMainView(readActiveEnvironmentId(), current);
    else if (remembered !== current) void showMainView(remembered);
  };
}
