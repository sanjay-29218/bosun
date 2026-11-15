import type { PointerEvent } from "react";

import { type ColumnSnap, snapWidth } from "../lib/columnSnap";
import { type ResizeBounds, useResizeDrag } from "./useResizeDrag";

interface SnapResizeSession {
  /** Whether the column was collapsed when the drag began. */
  readonly collapsed: boolean;
  readonly width: number;
  readonly bounds: ResizeBounds;
  readonly snap: ColumnSnap;
  /**
   * Shows the column at the pointer's width mid-drag, without touching state. `snapping` is
   * whether releasing here would leave the column collapsed.
   */
  readonly preview: (width: number, snapping: boolean) => void;
  /** Undoes the preview; runs before `commit`, in the same task, so nothing paints between. */
  readonly restore: () => void;
  /** Takes the released width; decide it with the same `snap`, through `snapDragResult`. */
  readonly commit: (width: number) => void;
}

/**
 * A right-edge drag that resizes a column and snaps it collapsed past a threshold, as the bot rail
 * and the thread list do. A release without movement commits nothing.
 */
export function useSnapResizeDrag<T extends HTMLElement>(
  start: (event: PointerEvent<T>) => SnapResizeSession | null,
) {
  return useResizeDrag<T>((event) => {
    const session = start(event);
    if (!session) return null;
    const snapBelow = snapWidth(session.collapsed, session.snap);
    return {
      width: session.width,
      edge: "right",
      bounds: session.bounds,
      resize(width) {
        session.preview(width, width < snapBelow);
        return width;
      },
      cleanup: session.restore,
      finish(width, moved) {
        if (moved) session.commit(width);
      },
    };
  });
}
