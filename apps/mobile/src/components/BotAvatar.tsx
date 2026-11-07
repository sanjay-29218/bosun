import {
  BOT_AVATAR_EYE_COLOR,
  BOT_AVATAR_VIEW_BOX,
  botAvatarPalette,
  botAvatarShapes,
  type BotAvatarShape,
} from "@t3tools/client-runtime/bot-avatar";
import type { BotAvatar as BotAvatarParts, ProjectIconColor } from "@t3tools/contracts";
import { memo } from "react";
import Svg, { Ellipse, G, Path, Rect } from "react-native-svg";

function Shape({ shape, color }: { readonly shape: BotAvatarShape; readonly color: string }) {
  switch (shape.kind) {
    case "rect":
      return (
        <Rect
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          rx={shape.r}
          fill={color}
        />
      );
    case "ellipse":
      return <Ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} fill={color} />;
    case "path":
      return shape.outline ? (
        <Path
          d={shape.d}
          fill={color}
          stroke={color}
          strokeWidth={shape.outline}
          strokeLinejoin="round"
        />
      ) : (
        <Path d={shape.d} fill={color} />
      );
    case "stroke":
      return (
        <Path
          d={shape.d}
          fill="none"
          stroke={color}
          strokeWidth={shape.width}
          strokeLinecap="round"
        />
      );
  }
}

/** A bot's flat avatar in its color. */
export const BotAvatar = memo(function BotAvatar(props: {
  readonly avatar: BotAvatarParts;
  readonly color: ProjectIconColor;
  readonly size?: number;
}) {
  const size = props.size ?? 28;
  const { body, eyes } = botAvatarShapes(props.avatar);
  const fill = botAvatarPalette(props.color).base;
  return (
    <Svg width={size} height={size} viewBox={BOT_AVATAR_VIEW_BOX} accessible={false}>
      <G>
        {body.map((shape) => (
          <Shape key={JSON.stringify(shape)} shape={shape} color={fill} />
        ))}
      </G>
      <G>
        {eyes.map((shape) => (
          <Shape key={JSON.stringify(shape)} shape={shape} color={BOT_AVATAR_EYE_COLOR} />
        ))}
      </G>
    </Svg>
  );
});
