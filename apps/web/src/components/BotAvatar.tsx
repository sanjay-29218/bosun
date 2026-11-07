import {
  BOT_AVATAR_EYE_COLOR,
  BOT_AVATAR_VIEW_BOX,
  botAvatarPalette,
  botAvatarShapes,
  type BotAvatarShape,
} from "@t3tools/client-runtime/bot-avatar";
import type { BotAvatar as BotAvatarParts, ProjectIconColor } from "@t3tools/contracts";
import { memo, useEffect, useRef } from "react";

import { botGlanceScheduler } from "../lib/botGlance";

const SIZES = { xs: 18, sm: 24, md: 32, lg: 64 } as const;

function Shape({ shape, color }: { readonly shape: BotAvatarShape; readonly color: string }) {
  switch (shape.kind) {
    case "rect":
      return (
        <rect
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          rx={shape.r}
          fill={color}
        />
      );
    case "ellipse":
      return <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} fill={color} />;
    case "path":
      return shape.outline ? (
        <path
          d={shape.d}
          fill={color}
          stroke={color}
          strokeWidth={shape.outline}
          strokeLinejoin="round"
        />
      ) : (
        <path d={shape.d} fill={color} />
      );
    case "stroke":
      return (
        <path
          d={shape.d}
          fill="none"
          stroke={color}
          strokeWidth={shape.width}
          strokeLinecap="round"
        />
      );
  }
}

/**
 * A bot's flat avatar in its color. While `working` and on screen it glances now and then,
 * timed by the app-wide glance scheduler.
 */
export const BotAvatar = memo(function BotAvatar({
  avatar,
  color,
  size = "md",
  working = false,
  className,
}: {
  readonly avatar: BotAvatarParts;
  readonly color: ProjectIconColor;
  readonly size?: keyof typeof SIZES | number;
  readonly working?: boolean;
  /** Ignored: avatars are always flat. Kept so callers that still pass it compile. */
  readonly shaded?: boolean;
  readonly className?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers with the shared glance timer and an IntersectionObserver
  useEffect(() => {
    const element = ref.current;
    if (!working || !element) return;
    const scheduler = botGlanceScheduler();
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) scheduler.register(element);
      else scheduler.unregister(element);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      scheduler.unregister(element);
    };
  }, [working]);

  const { body, eyes } = botAvatarShapes(avatar);
  const fill = botAvatarPalette(color).base;
  const pixels = typeof size === "number" ? size : SIZES[size];
  return (
    <svg
      ref={ref}
      viewBox={BOT_AVATAR_VIEW_BOX}
      width={pixels}
      height={pixels}
      aria-hidden
      className={className}
      onAnimationEnd={working ? () => ref.current?.removeAttribute("data-glance") : undefined}
    >
      <g data-body="">
        {body.map((shape) => (
          <Shape key={JSON.stringify(shape)} shape={shape} color={fill} />
        ))}
        <g data-eyes="">
          {eyes.map((shape) => (
            <Shape key={JSON.stringify(shape)} shape={shape} color={BOT_AVATAR_EYE_COLOR} />
          ))}
        </g>
      </g>
    </svg>
  );
});
