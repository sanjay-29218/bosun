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

// The Bots list opens a thread without changing the rail. Armed only once its open succeeded,
// right before navigating, and cleared by the next navigation, whichever thread it lands on.
let leaveRailFor: string | null = null;

/** The navigation to `${environmentId}:${threadId}` that follows leaves the rail as it is. */
export function leaveRailOnNextOpen(environmentId: string, threadId: string): void {
  leaveRailFor = `${environmentId}:${threadId}`;
}

/** Whether the rail should leave this navigation alone. Disarms whatever was armed. */
export function consumeLeaveRail(key: string | null): boolean {
  const leave = key !== null && key === leaveRailFor;
  leaveRailFor = null;
  return leave;
}
