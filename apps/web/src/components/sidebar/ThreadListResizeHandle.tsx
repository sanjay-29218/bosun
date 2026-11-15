import { useSnapResizeDrag } from "../../hooks/useSnapResizeDrag";
import { cn } from "../../lib/utils";
import { threadSidebarAfterDrag, threadSidebarSnap } from "../threadSidebarWidth";
import { useSidebar } from "../ui/sidebar";

const LIVE_PROPERTIES = ["width", "left", "opacity", "transition-duration"] as const;

/**
 * The thread list's right edge, kept outside the sidebar so it still works when the closed
 * sidebar turns inert. Dragging resizes the list; under its narrowest width the list slides
 * under the bot rail and closes on release. Closed, the edge sits beside the rail's own and
 * drags the list back out. Double-click resets the width.
 */
export function ThreadListResizeHandle(props: {
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly onResize: (width: number) => void;
  readonly onReset: () => void;
}) {
  const { open } = useSidebar();
  // Toggling the list mid-drag remounts the handle, which abandons the drag.
  return <ResizeEdge key={open ? "open" : "closed"} {...props} />;
}

function ResizeEdge({
  width,
  minWidth,
  maxWidth,
  onResize,
  onReset,
}: Parameters<typeof ThreadListResizeHandle>[0]) {
  const { open, setOpen } = useSidebar();
  const {
    ref: handleRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
  } = useSnapResizeDrag<HTMLDivElement>((event) => {
    const handle = event.currentTarget;
    const wrapper = handle.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    const container = wrapper?.querySelector<HTMLElement>(
      "[data-app-sidebar][data-slot='sidebar-container']",
    );
    const gap = container
      ?.closest<HTMLElement>("[data-slot='sidebar']")
      ?.querySelector<HTMLElement>("[data-slot='sidebar-gap']");
    if (!wrapper || !container || !gap) return null;
    const live = [gap, container, handle];
    // Inline styles move only these during the drag; restoring them before the state change
    // lets the sidebar's own transition run once, from where the drag left it.
    const preview = (pointerWidth: number, snapping: boolean) => {
      // Under the narrowest width the list keeps that width and slides left instead of squeezing.
      const columnWidth = open ? Math.max(pointerWidth, minWidth) : width;
      for (const element of live) element.style.setProperty("transition-duration", "0ms");
      gap.style.setProperty("width", `${pointerWidth}px`);
      container.style.setProperty("width", `${columnWidth}px`);
      container.style.setProperty(
        "left",
        `calc(var(--sidebar-leading-width) - ${columnWidth - pointerWidth}px)`,
      );
      handle.style.setProperty(
        "left",
        `calc(var(--sidebar-leading-width) + ${pointerWidth - 3}px)`,
      );
      // Dims the list while letting go would leave it closed.
      if (snapping) container.style.setProperty("opacity", "0.6");
      else container.style.removeProperty("opacity");
    };
    return {
      collapsed: !open,
      width: open ? width : 0,
      bounds: { min: 0, max: open ? maxWidth : width },
      snap: threadSidebarSnap(minWidth),
      preview,
      restore() {
        for (const element of live) {
          for (const property of LIVE_PROPERTIES) element.style.removeProperty(property);
        }
      },
      commit(pointerWidth) {
        const next = threadSidebarAfterDrag(open, pointerWidth, minWidth, maxWidth);
        if (next.width !== undefined) {
          // Sized before React re-renders, so the release doesn't flash the old width.
          wrapper.style.setProperty("--sidebar-width", `${next.width}px`);
          onResize(next.width);
        }
        if (next.open !== open) setOpen(next.open);
      },
    };
  });

  return (
    // Pointer only; the title bar's sidebar toggle and its shortcut are the keyboard way.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={open ? "Resize the thread list" : "Drag to open the thread list"}
      className={cn(
        "fixed inset-y-0 z-20 hidden w-1.5 cursor-col-resize touch-none [-webkit-app-region:no-drag] after:absolute after:inset-y-0 after:left-[2px] after:w-[2px] hover:after:bg-primary md:block",
        // Closed, it sits just right of the bot rail's edge so the two drags never overlap.
        open
          ? "left-[calc(var(--sidebar-leading-width)+var(--sidebar-width)-3px)]"
          : "left-[calc(var(--sidebar-leading-width)+3px)]",
      )}
      ref={handleRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onDoubleClick={() => {
        onReset();
        if (!open) setOpen(true);
      }}
    />
  );
}
