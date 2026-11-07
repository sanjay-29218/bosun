import { describe, expect, it } from "vite-plus/test";

import { BOT_AVATAR_PRESETS } from "./botAvatar.ts";
import { projectManagerLook } from "./projectManagerLook.ts";

describe("projectManagerLook", () => {
  it("keeps the look a person chose", () => {
    const icon = { avatar: BOT_AVATAR_PRESETS[3]!, color: "teal" as const };
    expect(projectManagerLook("project-1", icon)).toBe(icon);
  });

  it("derives the same look from a project id every time, and varies it across projects", () => {
    const ids = Array.from({ length: 24 }, (_, index) => `project-${index}`);
    expect(ids.map((id) => projectManagerLook(id, null))).toEqual(
      ids.map((id) => projectManagerLook(id, undefined)),
    );
    const looks = new Set(ids.map((id) => JSON.stringify(projectManagerLook(id, null))));
    expect(looks.size).toBeGreaterThan(12);
    // Each is a starter bot in the flat style, so it draws like a bot someone picked.
    for (const id of ids) {
      expect(BOT_AVATAR_PRESETS).toContainEqual(projectManagerLook(id, null).avatar);
    }
  });
});
