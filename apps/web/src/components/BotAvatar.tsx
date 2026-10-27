import {
  botAvatarPalette,
  botAvatarShapes,
  type BotAvatarPaint,
} from "@t3tools/client-runtime/bot-avatar";
import type { BotAvatar as BotAvatarParts, ProjectIconColor } from "@t3tools/contracts";
import { memo, useId } from "react";

const SIZES = { xs: 18, sm: 24, md: 32, lg: 64 } as const;

/** A bot's robot avatar, tinted with its color. `shaded={false}` draws it in flat colors. */
export const BotAvatar = memo(function BotAvatar({
  avatar,
  color,
  size = "md",
  shaded = true,
  className,
}: {
  readonly avatar: BotAvatarParts;
  readonly color: ProjectIconColor;
  readonly size?: keyof typeof SIZES | number;
  readonly shaded?: boolean;
  readonly className?: string;
}) {
  // Gradient ids are document-wide, so each avatar names its own.
  const id = `bot-${useId().replace(/[^\w-]/g, "")}`;
  const palette = botAvatarPalette(color);
  const paint = (name: BotAvatarPaint) =>
    name === "head" ? `url(#${id}-head)` : name === "visor" ? `url(#${id}-visor)` : palette[name];
  const pixels = typeof size === "number" ? size : SIZES[size];
  return (
    <svg viewBox="0 0 64 64" width={pixels} height={pixels} aria-hidden className={className}>
      <defs>
        <radialGradient id={`${id}-head`} cx="35%" cy="28%" r="80%">
          <stop offset="0" stopColor={palette.light} />
          <stop offset="0.5" stopColor={palette.base} />
          <stop offset="1" stopColor={palette.dark} />
        </radialGradient>
        <linearGradient id={`${id}-visor`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={palette.visorTop} />
          <stop offset="1" stopColor={palette.visorBottom} />
        </linearGradient>
      </defs>
      {botAvatarShapes(avatar, { shaded }).map((shape) => {
        switch (shape.kind) {
          case "rect":
            return (
              <rect
                key={JSON.stringify(shape)}
                x={shape.x}
                y={shape.y}
                width={shape.width}
                height={shape.height}
                rx={shape.r}
                fill={paint(shape.fill)}
                opacity={shape.opacity}
              />
            );
          case "ellipse":
            return (
              <ellipse
                key={JSON.stringify(shape)}
                cx={shape.cx}
                cy={shape.cy}
                rx={shape.rx}
                ry={shape.ry}
                fill={paint(shape.fill)}
                opacity={shape.opacity}
              />
            );
          case "path":
            return <path key={JSON.stringify(shape)} d={shape.d} fill={paint(shape.fill)} />;
          case "stroke":
            return (
              <path
                key={JSON.stringify(shape)}
                d={shape.d}
                fill="none"
                stroke={paint(shape.stroke)}
                strokeWidth={shape.width}
                strokeLinecap="round"
              />
            );
        }
      })}
    </svg>
  );
});
