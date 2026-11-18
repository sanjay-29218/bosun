import { type ColumnSnap, snapDragResult } from "../lib/columnSnap";

export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMinimumWidth(brandWidth: number): number {
  return Math.max(THREAD_SIDEBAR_MIN_WIDTH, Math.ceil(brandWidth));
}

export function resolveThreadSidebarMaximumWidth(
  viewportWidth: number,
  minimumWidth = THREAD_SIDEBAR_MIN_WIDTH,
): number {
  return Math.max(minimumWidth, Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH);
}

export function clampThreadSidebarWidth(
  width: number,
  minimumWidth: number,
  maximumWidth: number,
): number {
  return Math.min(maximumWidth, Math.max(minimumWidth, width));
}

export function resolveInitialThreadSidebarWidth(storedWidth: number | null): number {
  return storedWidth === null
    ? THREAD_SIDEBAR_DEFAULT_WIDTH
    : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
}

// Dragged this far under the narrowest width, the list closes; dragged this far out, it opens.
const THREAD_SIDEBAR_SNAP_DISTANCE = 64;

export const threadSidebarSnap = (minimumWidth: number): ColumnSnap => ({
  collapseBelow: minimumWidth - THREAD_SIDEBAR_SNAP_DISTANCE,
  expandFrom: THREAD_SIDEBAR_SNAP_DISTANCE,
});

/** Where a drag of the thread list's edge released at `width` leaves it. */
export function threadSidebarAfterDrag(
  open: boolean,
  width: number,
  minimumWidth: number,
  maximumWidth: number,
): { readonly open: boolean; readonly width?: number } {
  const result = snapDragResult(!open, width, threadSidebarSnap(minimumWidth));
  if (result.collapsed) return { open: false };
  return result.width === undefined
    ? { open: true }
    : { open: true, width: clampThreadSidebarWidth(result.width, minimumWidth, maximumWidth) };
}
