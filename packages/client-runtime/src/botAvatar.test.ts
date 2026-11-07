import { BOT_FACES, type BotAvatar } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOT_AVATAR_EYE_STYLES,
  BOT_AVATAR_PRESETS,
  BOT_AVATAR_SILHOUETTES,
  botAvatarEyeStyle,
  botAvatarSilhouette,
  randomBotAvatar,
  withBotAvatarEyeStyle,
  withBotAvatarSilhouette,
} from "./botAvatar.ts";

const avatar = (parts: Partial<BotAvatar>): BotAvatar => ({
  head: "round",
  face: "flat",
  eyes: "dash",
  top: "none",
  cheeks: false,
  smile: false,
  ...parts,
});

// Stored head → [silhouette for every other face, silhouette for face "bare"].
const SILHOUETTES = {
  round: ["blob", "heart"],
  squircle: ["squircle", "cloud"],
  wide: ["pebble", "bean"],
  tall: ["drop", "ghost"],
  dome: ["mushroom", "mushroom"],
  cat: ["cat", "cat"],
  peak: ["peak", "star"],
  gem: ["gem", "flower"],
} as const;

const EYES = {
  dash: "dashes",
  tall: "dashes",
  visor: "dashes",
  round: "dots",
  big: "dots",
  star: "dots",
  happy: "happy",
  heart: "happy",
  wink: "wink",
  sleepy: "sleepy",
} as const;

describe("botAvatarSilhouette", () => {
  it("maps every stored head and face to a silhouette", () => {
    for (const [head, [base, bare]] of Object.entries(SILHOUETTES)) {
      for (const face of BOT_FACES) {
        expect(botAvatarSilhouette(avatar({ head: head as BotAvatar["head"], face }))).toBe(
          face === "bare" ? bare : base,
        );
      }
    }
  });

  it("falls back for values a newer client wrote", () => {
    expect(botAvatarSilhouette(avatar({ head: "robot" as BotAvatar["head"] }))).toBe("blob");
    expect(botAvatarSilhouette(avatar({ head: "peak", face: "glass" as BotAvatar["face"] }))).toBe(
      "peak",
    );
  });

  it("round-trips every silhouette through the stored parts, keeping the rest", () => {
    const start = avatar({ top: "halo", cheeks: true, smile: true });
    for (const silhouette of BOT_AVATAR_SILHOUETTES) {
      const stored = withBotAvatarSilhouette(start, silhouette);
      expect(botAvatarSilhouette(stored)).toBe(silhouette);
      expect(stored.face === "bare" || stored.face === "flat").toBe(true);
      expect({ ...stored, head: start.head, face: start.face }).toEqual(start);
    }
  });
});

describe("botAvatarEyeStyle", () => {
  it("maps every stored eye value, and falls back to dashes", () => {
    for (const [eyes, style] of Object.entries(EYES)) {
      expect(botAvatarEyeStyle(avatar({ eyes: eyes as BotAvatar["eyes"] }))).toBe(style);
    }
    expect(botAvatarEyeStyle(avatar({ eyes: "laser" as BotAvatar["eyes"] }))).toBe("dashes");
  });

  it("round-trips every eye style", () => {
    for (const style of BOT_AVATAR_EYE_STYLES) {
      expect(botAvatarEyeStyle(withBotAvatarEyeStyle(avatar({}), style))).toBe(style);
    }
  });
});

describe("presets", () => {
  it("has one preset per silhouette", () => {
    expect(BOT_AVATAR_PRESETS.map(botAvatarSilhouette)).toEqual([...BOT_AVATAR_SILHOUETTES]);
  });

  it("shuffles across silhouettes and eyes", () => {
    expect(botAvatarSilhouette(randomBotAvatar(() => 0.999))).toBe("bean");
    expect(botAvatarEyeStyle(randomBotAvatar(() => 0.999))).toBe("sleepy");
  });
});
