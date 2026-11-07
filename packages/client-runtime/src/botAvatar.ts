import { BOT_HEADS, type BotAvatar, type ProjectIconColor } from "@t3tools/contracts";

/** One filled shape on the avatar's 64×64 canvas. Strokes have round caps and joins. */
export type BotAvatarShape =
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly r: number;
    }
  | {
      readonly kind: "ellipse";
      readonly cx: number;
      readonly cy: number;
      readonly rx: number;
      readonly ry: number;
    }
  /** `outline` strokes the path in its own fill, rounding its corners. */
  | { readonly kind: "path"; readonly d: string; readonly outline?: number }
  | { readonly kind: "stroke"; readonly d: string; readonly width: number };

export const BOT_AVATAR_SILHOUETTES = [
  "blob",
  "squircle",
  "pebble",
  "drop",
  "mushroom",
  "cat",
  "peak",
  "gem",
  "heart",
  "flower",
  "star",
  "cloud",
  "ghost",
  "bean",
] as const;
export type BotAvatarSilhouette = (typeof BOT_AVATAR_SILHOUETTES)[number];

export const BOT_AVATAR_EYE_STYLES = ["dashes", "dots", "happy", "wink", "sleepy"] as const;
export type BotAvatarEyeStyle = (typeof BOT_AVATAR_EYE_STYLES)[number];

export const BOT_AVATAR_EYE_COLOR = "#17171c";

// Tailwind's 500 shades, the same hues the project and bot color swatches use.
const BOT_COLOR_HEX: Record<ProjectIconColor, string> = {
  gray: "#6b7280",
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  yellow: "#eab308",
  lime: "#84cc16",
  green: "#22c55e",
  emerald: "#10b981",
  teal: "#14b8a6",
  cyan: "#06b6d4",
  sky: "#0ea5e9",
  blue: "#3b82f6",
  indigo: "#6366f1",
  violet: "#8b5cf6",
  purple: "#a855f7",
  fuchsia: "#d946ef",
  pink: "#ec4899",
  rose: "#f43f5e",
};

/** The flat fill an avatar in `color` paints its body with. */
export function botAvatarPalette(color: ProjectIconColor) {
  return { base: BOT_COLOR_HEX[color] ?? BOT_COLOR_HEX.gray } as const;
}

const circle = (cx: number, cy: number, r: number): BotAvatarShape => ({
  kind: "ellipse",
  cx,
  cy,
  rx: r,
  ry: r,
});

/** Each silhouette's body and the line its eyes sit on. */
const SILHOUETTES: Record<
  BotAvatarSilhouette,
  { readonly body: ReadonlyArray<BotAvatarShape>; readonly eyeY: number }
> = {
  blob: { body: [{ kind: "ellipse", cx: 32, cy: 33, rx: 22, ry: 19 }], eyeY: 33 },
  squircle: {
    body: [{ kind: "rect", x: 11, y: 12, width: 42, height: 42, r: 17 }],
    eyeY: 34,
  },
  pebble: { body: [{ kind: "ellipse", cx: 32, cy: 35, rx: 25, ry: 16 }], eyeY: 35 },
  drop: {
    body: [{ kind: "path", d: "M32 7C40 19 51 29 51 40a19 19 0 0 1-38 0C13 29 24 19 32 7z" }],
    eyeY: 41,
  },
  mushroom: {
    body: [
      { kind: "path", d: "M9 31a23 19 0 0 1 46 0c0 5-4 7-9 7H18c-5 0-9-2-9-7z" },
      { kind: "rect", x: 23, y: 34, width: 18, height: 21, r: 8 },
    ],
    eyeY: 27,
  },
  cat: {
    body: [{ kind: "path", d: "M13 23 15 9l11 9h12l11-9 2 14c4 7 4 22-6 29H19C9 45 9 30 13 23z" }],
    eyeY: 35,
  },
  peak: { body: [{ kind: "path", d: "M28 11q4-6 8 0l17 32q4 9-6 9H17q-10 0-6-9z" }], eyeY: 40 },
  gem: {
    body: [{ kind: "path", d: "M28 9q4-4 8 0l19 19q4 4 0 8L36 55q-4 4-8 0L9 36q-4-4 0-8z" }],
    eyeY: 32,
  },
  heart: {
    body: [
      {
        kind: "path",
        d: "M32 55C17 45 9 36 9 26a12 12 0 0 1 23-5 12 12 0 0 1 23 5c0 10-8 19-23 29z",
      },
    ],
    eyeY: 31,
  },
  flower: {
    body: [
      circle(32, 15, 10),
      circle(48, 27, 10),
      circle(42, 46, 10),
      circle(22, 46, 10),
      circle(16, 27, 10),
      circle(32, 33, 15),
    ],
    eyeY: 33,
  },
  star: {
    body: [
      {
        kind: "path",
        d: "M32 9 39 21 52 19 46 32 52 45 39 43 32 55 25 43 12 45 18 32 12 19 25 21z",
        outline: 7,
      },
    ],
    eyeY: 33,
  },
  cloud: {
    body: [
      circle(22, 36, 12),
      circle(35, 27, 15),
      circle(46, 38, 11),
      { kind: "rect", x: 11, y: 36, width: 44, height: 15, r: 7.5 },
    ],
    eyeY: 37,
  },
  ghost: {
    body: [
      {
        kind: "path",
        d: "M13 30a19 19 0 0 1 38 0v24l-6.3-4.5-6.3 4.5-6.4-4.5-6.3 4.5-6.4-4.5L13 54z",
      },
    ],
    eyeY: 30,
  },
  bean: {
    body: [
      { kind: "path", d: "M21 13c11-5 28 0 32 13 4 13-3 27-18 29S9 47 11 32c1-10 3-16 10-19z" },
    ],
    eyeY: 34,
  },
};

const dash = (x: number, y: number): BotAvatarShape => ({
  kind: "rect",
  x,
  y: y - 4.5,
  width: 4.2,
  height: 9,
  r: 2.1,
});

const EYES: Record<BotAvatarEyeStyle, (y: number) => ReadonlyArray<BotAvatarShape>> = {
  dashes: (y) => [dash(25.4, y), dash(34.4, y)],
  dots: (y) => [circle(27.5, y, 2.9), circle(36.5, y, 2.9)],
  happy: (y) => [{ kind: "stroke", d: `M24.5 ${y + 2}q3-5 6 0M33.5 ${y + 2}q3-5 6 0`, width: 2.6 }],
  wink: (y) => [dash(25.4, y), { kind: "stroke", d: `M33.5 ${y + 1}q3-4 6 0`, width: 2.6 }],
  sleepy: (y) => [{ kind: "stroke", d: `M24.5 ${y + 1}h6M33.5 ${y + 1}h6`, width: 2.6 }],
};

// The stored head picks the silhouette; `face: "bare"` picks a second one for six heads, so
// the 14 silhouettes need no new literals that older clients would fail to decode.
const SILHOUETTE_BY_HEAD: Record<
  BotAvatar["head"],
  readonly [BotAvatarSilhouette, BotAvatarSilhouette]
> = {
  round: ["blob", "heart"],
  squircle: ["squircle", "cloud"],
  wide: ["pebble", "bean"],
  tall: ["drop", "ghost"],
  dome: ["mushroom", "mushroom"],
  cat: ["cat", "cat"],
  peak: ["peak", "star"],
  gem: ["gem", "flower"],
};

const EYE_STYLE_BY_EYES: Record<BotAvatar["eyes"], BotAvatarEyeStyle> = {
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
};

const EYES_BY_STYLE: Record<BotAvatarEyeStyle, BotAvatar["eyes"]> = {
  dashes: "dash",
  dots: "round",
  happy: "happy",
  wink: "wink",
  sleepy: "sleepy",
};

export function botAvatarSilhouette(avatar: BotAvatar): BotAvatarSilhouette {
  const pair = SILHOUETTE_BY_HEAD[avatar.head] ?? SILHOUETTE_BY_HEAD.round;
  return pair[avatar.face === "bare" ? 1 : 0];
}

export function botAvatarEyeStyle(avatar: BotAvatar): BotAvatarEyeStyle {
  return EYE_STYLE_BY_EYES[avatar.eyes] ?? "dashes";
}

/** `avatar` stored so it draws `silhouette`; its other parts stay as they are. */
export function withBotAvatarSilhouette(
  avatar: BotAvatar,
  silhouette: BotAvatarSilhouette,
): BotAvatar {
  for (const head of BOT_HEADS) {
    const [base, bare] = SILHOUETTE_BY_HEAD[head];
    if (base === silhouette) return { ...avatar, head, face: "flat" };
    if (bare === silhouette) return { ...avatar, head, face: "bare" };
  }
  return avatar;
}

/** `avatar` stored so it draws `style` eyes. */
export function withBotAvatarEyeStyle(avatar: BotAvatar, style: BotAvatarEyeStyle): BotAvatar {
  return { ...avatar, eyes: EYES_BY_STYLE[style] };
}

/**
 * The avatar as a flat body, filled with `botAvatarPalette(color).base`, and two eyes in
 * `BOT_AVATAR_EYE_COLOR`. Kept as two groups so the working glance can move each.
 */
export function botAvatarShapes(avatar: BotAvatar): {
  readonly body: ReadonlyArray<BotAvatarShape>;
  readonly eyes: ReadonlyArray<BotAvatarShape>;
} {
  const { body, eyeY } = SILHOUETTES[botAvatarSilhouette(avatar)];
  return { body, eyes: EYES[botAvatarEyeStyle(avatar)](eyeY) };
}

const PLAIN: BotAvatar = {
  head: "round",
  face: "flat",
  eyes: "dash",
  top: "none",
  cheeks: false,
  smile: false,
};

const PRESET_EYES: ReadonlyArray<BotAvatarEyeStyle> = [
  "dashes",
  "dashes",
  "dots",
  "happy",
  "dashes",
  "wink",
  "dashes",
  "dots",
  "happy",
  "dashes",
  "sleepy",
  "dots",
  "dashes",
  "wink",
];

/** One starting avatar per silhouette; new bots take one nobody uses yet. */
export const BOT_AVATAR_PRESETS: ReadonlyArray<BotAvatar> = BOT_AVATAR_SILHOUETTES.map(
  (silhouette, index) =>
    withBotAvatarEyeStyle(withBotAvatarSilhouette(PLAIN, silhouette), PRESET_EYES[index]!),
);

/** A random silhouette and eyes, for the picker's Shuffle. */
export function randomBotAvatar(random: () => number = Math.random): BotAvatar {
  const pick = <T>(values: ReadonlyArray<T>) => values[Math.floor(random() * values.length)]!;
  return withBotAvatarEyeStyle(
    withBotAvatarSilhouette(PLAIN, pick(BOT_AVATAR_SILHOUETTES)),
    pick(BOT_AVATAR_EYE_STYLES),
  );
}
