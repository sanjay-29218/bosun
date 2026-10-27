import { describe, expect, it } from "vite-plus/test";

import { BOT_AVATAR_PRESETS, botAvatarShapes } from "./botAvatar.ts";

const paints = (shapes: ReturnType<typeof botAvatarShapes>) =>
  shapes.map((shape) => (shape.kind === "stroke" ? shape.stroke : shape.fill));

describe("botAvatarShapes", () => {
  it("draws an unshaded avatar in solid colors and keeps its face and accessories", () => {
    for (const avatar of BOT_AVATAR_PRESETS) {
      const shaded = botAvatarShapes(avatar);
      const flat = botAvatarShapes(avatar, { shaded: false });
      expect(paints(flat)).not.toContain("head");
      expect(paints(flat)).not.toContain("visor");
      expect(paints(flat)).not.toContain("shadow");
      // Only cheeks stay translucent; shine and glow go.
      expect(
        flat.filter(
          (shape) => "opacity" in shape && shape.opacity !== undefined && shape.fill !== "cheek",
        ),
      ).toEqual([]);
      for (const accessory of ["pop", "pop2", "cheek", "ink", "plate"] as const) {
        expect(paints(flat).includes(accessory)).toBe(
          paints(shaded).includes(accessory) || (accessory === "ink" && avatar.face === "visor"),
        );
      }
    }
  });
});
