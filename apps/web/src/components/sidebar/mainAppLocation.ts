import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { readActiveLogicalBotKey } from "../../state/botRail";
import { readActiveEnvironmentId, useActiveEnvironmentId } from "../../state/entities";

// Settings, Usage, and Pull Requests replace the sidebar utility row with a
// Back button. Everything else is the main app. Legacy `/projects/<key>` links
// redirect into settings, so they count too and are never remembered.
export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/pull-requests"
  );
}

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

let mainAppHref: string | null = null;
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

// Each bot remembers its view; before the rail knows a bot, the environment does.
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

// Mount once in the app shell. Records the latest main app URL so Back can
// return there no matter how many utility pages were visited since, and the
// view it shows so the toggle and the next launch return to it.
export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  const environmentId = useActiveEnvironmentId();
  useEffect(() => {
    if (href === null) return;
    mainAppHref = href;
    const pathname = href.split(/[?#]/, 1)[0] ?? href;
    // The index only forwards to a draft or the board, so it is neither view.
    if (pathname === "/") return;
    const view = mainViewForPathname(pathname);
    mainViewHrefs[view] = href;
    rememberMainView(environmentId, view);
  }, [environmentId, href]);
  return null;
}

// Leaves a utility page for the last main app URL, or the thread list when
// the app was opened directly on a utility page.
export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return useCallback(() => navigate({ href: mainAppHref ?? "/" }), [navigate]);
}

/**
 * Shows a main view where it was left. Remembered before navigating, so List's
 * fallback to `/` lands on a draft instead of bouncing back to the board.
 */
export function useShowMainView() {
  const navigate = useNavigate();
  return useCallback(
    (view: MainView, options?: { readonly replace?: boolean }) => {
      rememberMainView(readActiveEnvironmentId(), view);
      return navigate({
        href: mainViewHrefs[view] ?? (view === "board" ? BOARD_PATH : "/"),
        replace: options?.replace ?? false,
      });
    },
    [navigate],
  );
}

/** `board.toggle`: flips between the views from wherever the app is when it runs. */
export function useToggleMainView() {
  const router = useRouter();
  const showMainView = useShowMainView();
  return useCallback(() => {
    const { pathname } = router.state.location;
    return showMainView(
      toggledMainView(isSidebarUtilityPage(pathname) ? null : mainViewForPathname(pathname)),
    );
  }, [router, showMainView]);
}

/**
 * After switching bots, shows the view the new bot was left on (List or Board). A bot
 * without one, or a utility page, stays where it is.
 */
export function useFollowBotMainView() {
  const router = useRouter();
  const showMainView = useShowMainView();
  return useCallback(() => {
    const { pathname } = router.state.location;
    if (pathname === "/" || isSidebarUtilityPage(pathname)) return;
    const key = mainViewKey(readActiveEnvironmentId());
    const remembered = key === null ? undefined : readMainViews()[key];
    if (remembered && remembered !== mainViewForPathname(pathname)) void showMainView(remembered);
  }, [router, showMainView]);
}
