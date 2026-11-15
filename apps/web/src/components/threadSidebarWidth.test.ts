import { describe, expect, it } from "vite-plus/test";

import { threadSidebarAfterDrag } from "./threadSidebarWidth";

describe("threadSidebarAfterDrag", () => {
  it.each([
    ["resizes an open list", true, 300, { open: true, width: 300 }],
    ["clamps a resize to the narrowest list", true, 150, { open: true, width: 208 }],
    ["clamps a resize to the widest list", true, 700, { open: true, width: 600 }],
    ["closes an open list dragged 64px under its narrowest", true, 143, { open: false }],
    ["keeps a closed list closed under 64px", false, 63, { open: false }],
    ["opens a closed list at its remembered width", false, 64, { open: true }],
  ] as const)("%s", (_name, open, width, layout) => {
    expect(threadSidebarAfterDrag(open, width, 208, 600)).toEqual(layout);
  });
});
