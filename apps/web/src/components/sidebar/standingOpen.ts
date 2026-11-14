// Only the newest open of a headquarters or project manager navigates, so a slow environment's
// answer can't take the chat back from a later pick.
let latestOpen = 0;

/** Drops any headquarters or project manager still opening, for a pick that shouldn't be undone. */
export function supersedeStandingOpen(): void {
  latestOpen += 1;
}

/**
 * Starts an open: its result, or null once a later open began or something superseded it
 * before it finished.
 */
export function latestStandingOpen<A>(pending: Promise<A>): Promise<{ readonly value: A } | null> {
  latestOpen += 1;
  const request = latestOpen;
  return pending.then((value) => (request === latestOpen ? { value } : null));
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    /**
     * Set on the navigation to a standing thread the Bots list opened: the rail keeps its bot and
     * scope. It travels with the navigation, so one that is cancelled or never made carries none.
     */
    leaveRail?: boolean;
  }
}
