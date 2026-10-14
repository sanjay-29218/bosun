import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
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

/**
 * The view an environment last showed. Opening the app at `/` lands there.
 * Bots (#16) key this per bot instead.
 */
export function readMainView(environmentId: EnvironmentId | null): MainView {
  return (environmentId && readMainViews()[environmentId]) || "list";
}

function rememberMainView(environmentId: EnvironmentId | null, view: MainView) {
  if (environmentId === null) return;
  const views = readMainViews();
  if (views[environmentId] === view) return;
  try {
    setLocalStorageItem(
      MAIN_VIEW_STORAGE_KEY,
      { ...views, [environmentId]: view },
      MainViewsSchema,
    );
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
