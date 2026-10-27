import {
  BOT_EYES,
  BOT_FACES,
  BOT_HEADS,
  BOT_TOPS,
  type BotAvatar,
  type ProjectIconColor,
} from "@t3tools/contracts";

/**
 * Where a shape takes its color. `head` and `visor` are gradients each renderer defines once
 * per avatar; the rest are flat colors from `botAvatarPalette`.
 */
export type BotAvatarPaint =
  | "head"
  | "visor"
  | "base"
  | "dark"
  | "light"
  | "glow"
  | "white"
  | "cheek"
  | "shadow"
  | "plate"
  | "ink"
  | "pop"
  | "pop2";

/** One shape on the avatar's 64×64 canvas, in paint order. Strokes have round caps. */
export type BotAvatarShape =
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly r: number;
      readonly fill: BotAvatarPaint;
      readonly opacity?: number;
    }
  | {
      readonly kind: "ellipse";
      readonly cx: number;
      readonly cy: number;
      readonly rx: number;
      readonly ry: number;
      readonly fill: BotAvatarPaint;
      readonly opacity?: number;
    }
  | { readonly kind: "path"; readonly d: string; readonly fill: BotAvatarPaint }
  | {
      readonly kind: "stroke";
      readonly d: string;
      readonly stroke: BotAvatarPaint;
      readonly width: number;
    };

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

const mix = (from: string, to: string, amount: number) => {
  const channels = (hex: string) =>
    [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  const a = channels(from);
  const b = channels(to);
  return `#${a
    .map((value, index) =>
      Math.round(value + (b[index]! - value) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

/** The flat colors an avatar in `color` paints with; `light` to `dark` also make its head. */
export function botAvatarPalette(color: ProjectIconColor) {
  const base = BOT_COLOR_HEX[color];
  return {
    base,
    light: mix(base, "#ffffff", 0.55),
    dark: mix(base, "#000000", 0.45),
    glow: "#8ff7ff",
    white: "#ffffff",
    cheek: "#ff8fb1",
    shadow: "#000000",
    plate: "#f6f2ea",
    ink: "#1b1e2b",
    pop: "#fbbf24",
    pop2: "#fb7185",
    visorTop: "#232838",
    visorBottom: "#07080d",
  } as const;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Each head's outline, its bounding box, and where its face sits. */
const HEADS: Record<
  BotAvatar["head"],
  { readonly box: Box; readonly r: number; readonly face: Box; readonly outline?: string }
> = {
  squircle: {
    box: { x: 11, y: 20, width: 42, height: 36 },
    r: 14,
    face: { x: 17, y: 27, width: 30, height: 18 },
  },
  round: {
    box: { x: 11, y: 17, width: 42, height: 42 },
    r: 21,
    face: { x: 17, y: 29, width: 30, height: 18 },
  },
  wide: {
    box: { x: 7, y: 23, width: 50, height: 31 },
    r: 15,
    face: { x: 13, y: 30, width: 38, height: 17 },
  },
  tall: {
    box: { x: 15, y: 14, width: 34, height: 44 },
    r: 16,
    face: { x: 20, y: 25, width: 24, height: 20 },
  },
  dome: {
    box: { x: 10, y: 14, width: 44, height: 42 },
    r: 0,
    face: { x: 16, y: 31, width: 32, height: 17 },
    outline: "M10 50V36A22 22 0 0 1 54 36V50Q54 56 48 56H16Q10 56 10 50Z",
  },
  cat: {
    box: { x: 11, y: 22, width: 42, height: 34 },
    r: 14,
    face: { x: 17, y: 29, width: 30, height: 17 },
  },
  // A rounded triangle and a rounded diamond, from flat character sets.
  peak: {
    box: { x: 9, y: 12, width: 46, height: 43 },
    r: 0,
    face: { x: 18, y: 35, width: 28, height: 13 },
    outline: "M27.6 16.4Q32 9.4 36.4 16.4L53.4 46.4Q57.4 55 48 55H16Q6.6 55 10.6 46.4Z",
  },
  gem: {
    box: { x: 9, y: 9, width: 46, height: 46 },
    r: 0,
    face: { x: 18, y: 25.5, width: 28, height: 13 },
    outline:
      "M27.4 12.4Q32 8 36.6 12.4L51.6 27.4Q56 32 51.6 36.6L36.6 51.6Q32 56 27.4 51.6L12.4 36.6Q8 32 12.4 27.4Z",
  },
};

/**
 * The avatar as shapes to paint in order. `shaded: false` draws it in solid colors, without
 * gradient, shine, shadow or glow, keeping its face and accessories.
 */
export function botAvatarShapes(
  avatar: BotAvatar,
  { shaded = true }: { readonly shaded?: boolean } = {},
): ReadonlyArray<BotAvatarShape> {
  const { box, r, face, outline } = HEADS[avatar.head];
  const shapes: BotAvatarShape[] = [];
  const top = box.y;
  // A flat avatar is one solid color: no gradient, shine or shadow.
  const flat = avatar.face === "flat";
  const shine = shaded && !flat;
  const skin: BotAvatarPaint = shine ? "head" : "base";
  const bareFace = avatar.face === "bare" || flat;
  // Eyes glow on a visor and are inked on a plate or the bare head.
  const iris: BotAvatarPaint = avatar.face === "visor" ? "glow" : "ink";
  const eyeY = face.y + face.height / 2 + (bareFace ? -1 : 0) + (flat ? -2 : 0);
  // Flat eyes sit close together and glance aside, as flat characters do.
  const spread = flat ? 4.4 : Math.min(8, face.width / 4);
  const center = flat ? 37 : 32;
  const [left, right] = [center - spread, center + spread];

  const knob = (cx: number, cy: number, radius: number) => {
    shapes.push({ kind: "ellipse", cx, cy, rx: radius, ry: radius, fill: skin });
    if (!shine) return;
    shapes.push({
      kind: "ellipse",
      cx: cx - radius * 0.35,
      cy: cy - radius * 0.35,
      rx: radius * 0.35,
      ry: radius * 0.35,
      fill: "white",
      opacity: 0.7,
    });
  };

  // Behind the head: its shadow, cat ears, side pods and headphone cups.
  if (shine)
    shapes.push({
      kind: "ellipse",
      cx: 32,
      cy: box.y + box.height + 3.5,
      rx: box.width / 2 - 3,
      ry: 2.6,
      fill: "shadow",
      opacity: 0.45,
    });
  if (avatar.head === "cat") {
    shapes.push({ kind: "path", d: `M14 ${top + 9}L16 ${top - 9}L29 ${top + 2}Z`, fill: skin });
    shapes.push({ kind: "path", d: `M50 ${top + 9}L48 ${top - 9}L35 ${top + 2}Z`, fill: skin });
    shapes.push({ kind: "path", d: `M17 ${top + 4}L18 ${top - 4}L24 ${top + 1}Z`, fill: "cheek" });
    shapes.push({ kind: "path", d: `M47 ${top + 4}L46 ${top - 4}L40 ${top + 1}Z`, fill: "cheek" });
  }
  if (avatar.top === "ears") {
    for (const x of [box.x - 5, box.x + box.width - 3]) {
      shapes.push({
        kind: "rect",
        x,
        y: box.y + box.height / 2 - 8,
        width: 8,
        height: 16,
        r: 4,
        fill: skin,
      });
    }
  }

  shapes.push(
    outline ? { kind: "path", d: outline, fill: skin } : { kind: "rect", ...box, r, fill: skin },
  );
  if (shine)
    shapes.push({
      kind: "ellipse",
      cx: box.x + box.width * 0.3,
      cy: box.y + (outline ? 8 : 4.5),
      rx: box.width * 0.2,
      ry: 2.6,
      fill: "white",
      opacity: 0.35,
    });

  switch (avatar.top) {
    case "ball":
      shapes.push({
        kind: "rect",
        x: 30.6,
        y: top - 9,
        width: 2.8,
        height: 10,
        r: 1.4,
        fill: "dark",
      });
      knob(32, top - 10, 4.6);
      break;
    case "double":
      shapes.push({
        kind: "stroke",
        d: `M24 ${top + 2}L19 ${top - 8}M40 ${top + 2}L45 ${top - 8}`,
        stroke: "dark",
        width: 2.6,
      });
      knob(19, top - 9, 3.6);
      knob(45, top - 9, 3.6);
      break;
    case "sprout":
      shapes.push({
        kind: "path",
        d: `M32 ${top + 1}C32 ${top - 5} 30 ${top - 8} 26 ${top - 10}C31 ${top - 11} 34 ${top - 7} 32 ${top + 1}Z`,
        fill: "light",
      });
      shapes.push({
        kind: "path",
        d: `M32 ${top + 1}C33 ${top - 6} 36 ${top - 9} 40 ${top - 9}C38 ${top - 5} 35 ${top - 3} 32 ${top + 1}Z`,
        fill: "base",
      });
      break;
    case "propeller":
      shapes.push({
        kind: "rect",
        x: 30.8,
        y: top - 6,
        width: 2.4,
        height: 7,
        r: 1.2,
        fill: "dark",
      });
      shapes.push({ kind: "ellipse", cx: 24.5, cy: top - 7, rx: 7.5, ry: 2.4, fill: "pop" });
      shapes.push({ kind: "ellipse", cx: 39.5, cy: top - 7, rx: 7.5, ry: 2.4, fill: "pop2" });
      shapes.push({ kind: "ellipse", cx: 32, cy: top - 7, rx: 2.6, ry: 2.6, fill: skin });
      break;
    case "headphones":
      shapes.push({
        kind: "stroke",
        d: `M${box.x + 2} ${box.y + box.height * 0.45}Q32 ${top - 14} ${box.x + box.width - 2} ${box.y + box.height * 0.45}`,
        stroke: "ink",
        width: 3.4,
      });
      for (const x of [box.x - 4, box.x + box.width - 5]) {
        shapes.push({
          kind: "rect",
          x,
          y: box.y + box.height * 0.32,
          width: 9,
          height: 15,
          r: 4.5,
          fill: "ink",
        });
        shapes.push({
          kind: "rect",
          x: x + 2.5,
          y: box.y + box.height * 0.32 + 3,
          width: 4,
          height: 9,
          r: 2,
          fill: "pop",
        });
      }
      break;
    case "bow":
      shapes.push({ kind: "path", d: `M42 ${top + 1}L35 ${top - 6}L35 ${top + 7}Z`, fill: "pop2" });
      shapes.push({ kind: "path", d: `M42 ${top + 1}L50 ${top - 6}L50 ${top + 7}Z`, fill: "pop2" });
      shapes.push({ kind: "ellipse", cx: 42, cy: top + 1, rx: 2.6, ry: 2.6, fill: "cheek" });
      break;
    case "halo":
      shapes.push({
        kind: "stroke",
        d: `M20 ${top - 6}a12 3.6 0 1 0 24 0a12 3.6 0 1 0 -24 0`,
        stroke: "pop",
        width: 2.6,
      });
      break;
    case "horns":
      shapes.push({
        kind: "path",
        d: `M21 ${top + 3}Q14 ${top - 4} 17 ${top - 11}Q20 ${top - 4} 27 ${top + 1}Z`,
        fill: "pop2",
      });
      shapes.push({
        kind: "path",
        d: `M43 ${top + 3}Q50 ${top - 4} 47 ${top - 11}Q44 ${top - 4} 37 ${top + 1}Z`,
        fill: "pop2",
      });
      break;
    case "ears":
    case "none":
      break;
  }

  if (avatar.face === "visor") {
    shapes.push({ kind: "rect", ...face, r: face.height / 2, fill: shaded ? "visor" : "ink" });
    if (shaded)
      shapes.push({
        kind: "rect",
        x: face.x + 3,
        y: face.y + 1.6,
        width: face.width * 0.45,
        height: Math.max(2, face.height * 0.18),
        r: 1.4,
        fill: "white",
        opacity: 0.1,
      });
  } else if (avatar.face === "plate") {
    shapes.push({ kind: "rect", ...face, r: 7, fill: "plate" });
  }

  const eye = (
    x: number,
    kind: "round" | "happy" | "closed" | "star" | "tall" | "heart" | "big" | "dash",
  ) => {
    switch (kind) {
      case "dash":
        shapes.push({
          kind: "stroke",
          d: `M${x - 1.1} ${eyeY + 3}L${x + 1.1} ${eyeY - 3}`,
          stroke: iris,
          width: 3.8,
        });
        return;
      case "round":
        if (iris === "glow" && shaded) {
          shapes.push({
            kind: "ellipse",
            cx: x,
            cy: eyeY,
            rx: 5.2,
            ry: 5.2,
            fill: "glow",
            opacity: 0.18,
          });
        }
        shapes.push({ kind: "ellipse", cx: x, cy: eyeY, rx: 3.3, ry: 3.3, fill: iris });
        shapes.push({
          kind: "ellipse",
          cx: x - 1.1,
          cy: eyeY - 1.2,
          rx: 1.1,
          ry: 1.1,
          fill: "white",
        });
        return;
      case "big":
        shapes.push({ kind: "ellipse", cx: x, cy: eyeY, rx: 4.4, ry: 5, fill: iris });
        shapes.push({
          kind: "ellipse",
          cx: x - 1.4,
          cy: eyeY - 1.8,
          rx: 1.6,
          ry: 1.6,
          fill: "white",
        });
        shapes.push({
          kind: "ellipse",
          cx: x + 1.6,
          cy: eyeY + 2,
          rx: 0.8,
          ry: 0.8,
          fill: "white",
        });
        return;
      case "happy":
        shapes.push({
          kind: "stroke",
          d: `M${x - 3.6} ${eyeY + 1.6}Q${x} ${eyeY - 3.4} ${x + 3.6} ${eyeY + 1.6}`,
          stroke: iris,
          width: 2.6,
        });
        return;
      case "closed":
        shapes.push({
          kind: "stroke",
          d: `M${x - 3.4} ${eyeY}H${x + 3.4}`,
          stroke: iris,
          width: 2.6,
        });
        return;
      case "star":
        shapes.push({
          kind: "path",
          d: `M${x} ${eyeY - 4.4}Q${x + 0.7} ${eyeY - 0.7} ${x + 4.4} ${eyeY}Q${x + 0.7} ${eyeY + 0.7} ${x} ${eyeY + 4.4}Q${x - 0.7} ${eyeY + 0.7} ${x - 4.4} ${eyeY}Q${x - 0.7} ${eyeY - 0.7} ${x} ${eyeY - 4.4}Z`,
          fill: iris === "glow" ? "glow" : "pop",
        });
        return;
      case "tall":
        shapes.push({
          kind: "rect",
          x: x - 2.2,
          y: eyeY - 4.2,
          width: 4.4,
          height: 8.4,
          r: 2.2,
          fill: iris,
        });
        shapes.push({
          kind: "rect",
          x: x - 1.6,
          y: eyeY - 3.4,
          width: 1.4,
          height: 2.4,
          r: 0.7,
          fill: "white",
        });
        return;
      case "heart":
        shapes.push({
          kind: "path",
          d: `M${x} ${eyeY + 3.8}C${x - 5.6} ${eyeY} ${x - 4.6} ${eyeY - 4.4} ${x - 2.2} ${eyeY - 4.4}C${x - 0.9} ${eyeY - 4.4} ${x} ${eyeY - 3.4} ${x} ${eyeY - 2.4}C${x} ${eyeY - 3.4} ${x + 0.9} ${eyeY - 4.4} ${x + 2.2} ${eyeY - 4.4}C${x + 4.6} ${eyeY - 4.4} ${x + 5.6} ${eyeY} ${x} ${eyeY + 3.8}Z`,
          fill: "pop2",
        });
        return;
    }
  };
  switch (avatar.eyes) {
    case "wink":
      eye(left, "round");
      eye(right, "happy");
      break;
    case "sleepy":
      eye(left, "closed");
      eye(right, "closed");
      break;
    case "visor":
      if (iris === "glow" && shaded) {
        shapes.push({
          kind: "rect",
          x: center - 11,
          y: eyeY - 2.4,
          width: 22,
          height: 4.8,
          r: 2.4,
          fill: "glow",
          opacity: 0.25,
        });
      }
      shapes.push({
        kind: "rect",
        x: center - 9,
        y: eyeY - 1.6,
        width: 18,
        height: 3.2,
        r: 1.6,
        fill: iris,
      });
      break;
    default:
      eye(left, avatar.eyes);
      eye(right, avatar.eyes);
  }

  // A bare face smiles under its eyes; the others smile under their visor or plate.
  const mouthY = bareFace ? eyeY + 7 : face.y + face.height + 4.5;
  if (avatar.smile) {
    shapes.push({
      kind: "stroke",
      d: `M${center - 2.5} ${mouthY}Q${center} ${mouthY + 2.1} ${center + 2.5} ${mouthY}`,
      stroke: bareFace ? "ink" : "dark",
      width: 1.8,
    });
  }
  if (avatar.cheeks) {
    const cheekY = bareFace ? eyeY + 5 : face.y + face.height + 5;
    for (const cx of [face.x + 1, face.x + face.width - 1]) {
      shapes.push({
        kind: "ellipse",
        cx,
        cy: cheekY,
        rx: 3.4,
        ry: 2,
        fill: "cheek",
        opacity: 0.55,
      });
    }
  }
  return shapes;
}

/** Starting avatars that look good together and unlike each other; new bots take one. */
export const BOT_AVATAR_PRESETS: ReadonlyArray<BotAvatar> = [
  { head: "squircle", face: "visor", eyes: "round", top: "ball", cheeks: false, smile: true },
  { head: "round", face: "plate", eyes: "happy", top: "bow", cheeks: true, smile: false },
  { head: "wide", face: "visor", eyes: "visor", top: "headphones", cheeks: false, smile: false },
  { head: "cat", face: "bare", eyes: "big", top: "none", cheeks: true, smile: true },
  { head: "tall", face: "plate", eyes: "tall", top: "propeller", cheeks: false, smile: true },
  { head: "dome", face: "visor", eyes: "star", top: "halo", cheeks: true, smile: false },
  { head: "round", face: "bare", eyes: "heart", top: "sprout", cheeks: true, smile: true },
  { head: "squircle", face: "plate", eyes: "wink", top: "horns", cheeks: false, smile: true },
  { head: "dome", face: "bare", eyes: "sleepy", top: "double", cheeks: true, smile: false },
  { head: "wide", face: "plate", eyes: "round", top: "ears", cheeks: false, smile: true },
  { head: "round", face: "flat", eyes: "dash", top: "none", cheeks: false, smile: false },
  { head: "peak", face: "flat", eyes: "dash", top: "none", cheeks: false, smile: false },
  { head: "gem", face: "flat", eyes: "dash", top: "none", cheeks: false, smile: false },
];

/** A random avatar from all the parts, for the editor's shuffle. */
export function randomBotAvatar(random: () => number = Math.random): BotAvatar {
  const pick = <T>(values: ReadonlyArray<T>) => values[Math.floor(random() * values.length)]!;
  return {
    head: pick(BOT_HEADS),
    face: pick(BOT_FACES),
    eyes: pick(BOT_EYES),
    top: pick(BOT_TOPS),
    cheeks: random() < 0.5,
    smile: random() < 0.5,
  };
}
