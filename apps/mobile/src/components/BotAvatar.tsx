import {
  botAvatarPalette,
  botAvatarShapes,
  type BotAvatarPaint,
} from "@t3tools/client-runtime/bot-avatar";
import type { BotAvatar as BotAvatarParts, ProjectIconColor } from "@t3tools/contracts";
import { memo, useId } from "react";
import Svg, {
  Defs,
  Ellipse,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";

/** A bot's robot avatar, tinted with its color. */
export const BotAvatar = memo(function BotAvatar(props: {
  readonly avatar: BotAvatarParts;
  readonly color: ProjectIconColor;
  readonly size?: number;
}) {
  // Gradient ids are shared by every SVG on screen, so each avatar names its own.
  const id = `bot-${useId().replace(/[^\w-]/g, "")}`;
  const size = props.size ?? 28;
  const palette = botAvatarPalette(props.color);
  const paint = (name: BotAvatarPaint) =>
    name === "head" ? `url(#${id}-head)` : name === "visor" ? `url(#${id}-visor)` : palette[name];
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessible={false}>
      <Defs>
        <RadialGradient id={`${id}-head`} cx="35%" cy="28%" r="80%">
          <Stop offset="0" stopColor={palette.light} />
          <Stop offset="0.5" stopColor={palette.base} />
          <Stop offset="1" stopColor={palette.dark} />
        </RadialGradient>
        <LinearGradient id={`${id}-visor`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={palette.visorTop} />
          <Stop offset="1" stopColor={palette.visorBottom} />
        </LinearGradient>
      </Defs>
      {botAvatarShapes(props.avatar).map((shape, index) => {
        switch (shape.kind) {
          case "rect":
            return (
              <Rect
                key={index}
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
              <Ellipse
                key={index}
                cx={shape.cx}
                cy={shape.cy}
                rx={shape.rx}
                ry={shape.ry}
                fill={paint(shape.fill)}
                opacity={shape.opacity}
              />
            );
          case "path":
            return <Path key={index} d={shape.d} fill={paint(shape.fill)} />;
          case "stroke":
            return (
              <Path
                key={index}
                d={shape.d}
                fill="none"
                stroke={paint(shape.stroke)}
                strokeWidth={shape.width}
                strokeLinecap="round"
              />
            );
        }
      })}
    </Svg>
  );
});
