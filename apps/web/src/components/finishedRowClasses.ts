/**
 * Lineage's dimmed look for finished work, shared by Lineage and the sidebar's child features.
 * The row that owns the dimming carries `group/finished`, so only hovering or focusing that row
 * brightens it, not any outer `group` such as the sidebar.
 */
export const FINISHED_ROW_GROUP_CLASS = "group/finished";
export const FINISHED_ROW_ICON_CLASS =
  "opacity-40 grayscale group-focus-within/finished:opacity-100 group-focus-within/finished:grayscale-0 group-hover/finished:opacity-100 group-hover/finished:grayscale-0";
export const FINISHED_ROW_TITLE_CLASS =
  "font-normal text-secondary-label/70 group-focus-within/finished:text-foreground group-hover/finished:text-foreground";
