/** Where a dragged column edge snaps shut (to icons, or closed) or back open, in px. */
export interface ColumnSnap {
  /** Released under this, a drag that started open ends collapsed. */
  readonly collapseBelow: number;
  /** Released at or past this, a drag that started collapsed ends open. */
  readonly expandFrom: number;
}

/** Under this width a drag that started `collapsed` ends collapsed. */
export const snapWidth = (collapsed: boolean, snap: ColumnSnap) =>
  collapsed ? snap.expandFrom : snap.collapseBelow;

export type SnapDragResult =
  | { readonly collapsed: true }
  // No width when expanding: the column reopens at its remembered width, since the pointer's
  // is only a gesture out of the collapsed column.
  | { readonly collapsed: false; readonly width?: number };

export function snapDragResult(
  collapsed: boolean,
  width: number,
  snap: ColumnSnap,
): SnapDragResult {
  if (width < snapWidth(collapsed, snap)) return { collapsed: true };
  return collapsed ? { collapsed: false } : { collapsed: false, width };
}
