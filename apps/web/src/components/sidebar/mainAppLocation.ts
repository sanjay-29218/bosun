import { useLocation, useNavigate, useRouter, type AnyRouter } from "@tanstack/react-router";
import { headquartersBotId, headquartersProjectId, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { GUEST_PAGE_PATH } from "../../guestPage";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { withoutAssistantCitationHash } from "../../lib/assistantCitationNavigation";
import {
  readActiveLogicalBotKey,
  requestBotFirstThread,
  selectBotOfHeadquarters,
} from "../../state/botRail";
import { readActiveEnvironmentId } from "../../state/entities";
import {
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "../../threadRoutes";

/** Settings and Usage open as modals over the last main-app view. */
export function isAppModalPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/usage";
}

export const AUTOMATIONS_PATH = "/automations";
/** Every bot and project manager, pinned to the rail or not. */
export const BOTS_LIST_PATH = "/bots/all";
/** Bots, workflows and roles are added and edited in Settings → Crew. */
export const BOTS_SETTINGS_PATH = "/settings/bots";
export const WORKFLOWS_SETTINGS_PATH = "/settings/workflows";
export const ROLES_SETTINGS_PATH = "/settings/roles";

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname.startsWith("/projects/") ||
    pathname === "/pull-requests" ||
    pathname === AUTOMATIONS_PATH ||
    pathname === BOTS_LIST_PATH
  );
}

/**
 * What the rail points at: the bots (the picked bot's threads) or one of its places. The sidebar
 * column shows the destination's list.
 */
export type RailDestination = "bots" | "bots-list" | "automations" | "pull-requests";

const railDestinationForPathname = (pathname: string): RailDestination =>
  pathname === AUTOMATIONS_PATH
    ? "automations"
    : pathname === BOTS_LIST_PATH
      ? "bots-list"
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
 * The main app has two views, flipped by the board toggle in the top bar: List is the
 * thread view, Board the feature board. The route decides which one shows, so a board
 * link opens the board and opening a thread from it is List again.
 */
export type MainView = "list" | "board";
export const BOARD_PATH = "/board";

export const mainViewForPathname = (pathname: string): MainView =>
  pathname === BOARD_PATH ? "board" : "list";

/** What `board.toggle` shows: List from the board, the board from anywhere else. */
const toggledMainView = (current: MainView | null): MainView =>
  current === "board" ? "list" : "board";

// Pages the root route always renders without the app shell, so they are never
// a page to return to. Other paths seen before auth or on a prompt-link landing
// are still recorded; they are real app URLs, so returning to one is harmless.
const SHELL_LESS_PATHS = new Set(["/pair", "/connect", "/connect-agent", GUEST_PAGE_PATH]);

let mainAppHref: string | null = null;
// A headquarters or project manager belongs to its own bot, so it is never a bot's last page.
let mainAppHrefIsStanding = false;
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

// Each bot remembers its view; a rail that knows no bot yet uses the environment.
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

// Where each bot was left: its board, a thread, or its headquarters. Lost on reload, when a
// bot's first click opens its headquarters again.
const botHrefs = new Map<string, string>();

/** The page the bot showed last in this session, if any. */
export const readBotHref = (botKey: string) => botHrefs.get(botKey);

/** Saves the main page on screen for `botKey`, which the app may have opened on before bots loaded. */
export function rememberBotHref(botKey: string) {
  if (mainAppHref !== null && !mainAppHrefIsStanding) botHrefs.set(botKey, mainAppHref);
}
let appModalReturnHistoryIndex: number | null = null;
let appModalReturnThreadTarget: ThreadRouteTarget | null = null;

/**
 * Remembers where Settings, Usage, and the utility pages lead back to, and the main view
 * each location shows so the List / Board toggle and the next launch return to it.
 */
export function startMainAppLocationTracking(router: AnyRouter): () => void {
  const record = () => {
    const { pathname } = router.state.location;
    if (isAppModalPage(pathname) || SHELL_LESS_PATHS.has(pathname)) return;
    const href = withoutAssistantCitationHash(router.state.location.href);
    appModalReturnHref = href;
    // Only an entry that is exactly the return location can be stepped back to.
    appModalReturnHistoryIndex =
      href === router.state.location.href ? router.state.location.state.__TSR_index : null;
    appModalReturnThreadTarget = resolveThreadRouteTarget(
      router.state.matches.at(-1)?.params ?? {},
    );
    if (isSidebarUtilityPage(pathname)) return;
    const thread = resolveThreadRouteRef(router.state.matches.at(-1)?.params ?? {});
    const headquartersOf = thread ? headquartersBotId(thread.threadId) : null;
    mainAppHref = href;
    mainAppHrefIsStanding =
      headquartersOf !== null ||
      (thread !== null && headquartersProjectId(thread.threadId) !== null);
    // The index only forwards to a draft or the board, so it is neither view.
    if (pathname === "/") return;
    if (thread && headquartersOf !== null) {
      selectBotOfHeadquarters(thread.environmentId, headquartersOf);
    }
    const view = mainViewForPathname(pathname);
    mainViewHrefs[view] = href;
    rememberMainView(readActiveEnvironmentId(), view);
    const botKey = readActiveLogicalBotKey();
    if (botKey !== null && !mainAppHrefIsStanding) botHrefs.set(botKey, href);
  };
  record();
  return router.subscribe("onResolved", record);
}

/** The thread Settings or Usage opened over, for views mounted while the modal is open. */
export function getAppModalReturnThreadTarget() {
  return appModalReturnThreadTarget;
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
  const router = useRouter();
  return () => {
    const href = appModalReturnHref ?? mainAppHref ?? "/";
    const returnIndex = appModalReturnHistoryIndex ?? 0;
    const steps = router.state.location.state.__TSR_index - returnIndex;
    if (returnIndex === 0 || steps <= 0) return navigate({ href });
    // Go back to the entry before the return page and push it again: only a push drops the
    // modal's entries from forward history, and reusing the old entry avoids a duplicate stop.
    const unsubscribe = router.history.subscribe(() => {
      unsubscribe();
      void navigate({ href });
    });
    router.history.go(-(steps + 1));
  };
}

/**
 * Shows a main view where it was left. Remembered before navigating, so List's
 * fallback to `/` lands on a draft instead of bouncing back to the board.
 */
function showMainView(router: AnyRouter, view: MainView, options?: { readonly replace?: boolean }) {
  rememberMainView(readActiveEnvironmentId(), view);
  return router.navigate({
    href: mainViewHrefs[view] ?? (view === "board" ? BOARD_PATH : "/"),
    replace: options?.replace ?? false,
  });
}

export function useShowMainView() {
  const router = useRouter();
  return (view: MainView, options?: { readonly replace?: boolean }) =>
    showMainView(router, view, options);
}

/** `board.toggle`: flips between the views from wherever the app is when it runs. */
export function toggleMainView(router: AnyRouter) {
  const { pathname } = router.state.location;
  return showMainView(
    router,
    toggledMainView(isOutsideMainView(pathname) ? null : mainViewForPathname(pathname)),
  );
}

export function useToggleMainView() {
  const router = useRouter();
  return () => toggleMainView(router);
}

/**
 * Switches bots through `select`, keeping List / Board per bot: the view on screen is saved
 * for the bot being left, then the new bot's saved view shows. A bot without one keeps the
 * current view and saves it. The thread list opens the new bot's first thread, which the sidebar
 * picks once it lists that bot. From a utility page it opens the new bot's view.
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
    if (!utility && !current) return;
    const key = mainViewKey(readActiveEnvironmentId());
    const remembered = key === null ? undefined : readMainViews()[key];
    const view = remembered ?? current ?? "list";
    if (!remembered) rememberMainView(readActiveEnvironmentId(), view);
    if (view === "list") {
      requestBotFirstThread(readActiveLogicalBotKey());
      // A utility page has no thread list to answer the request, so go to the list first.
      if (utility) void showMainView("list");
      return;
    }
    if (utility || view !== current) void showMainView(view);
  };
}
