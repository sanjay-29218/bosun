import {
  BOT_AVATAR_EYE_STYLES,
  BOT_AVATAR_SILHOUETTES,
  botAvatarEyeStyle,
  botAvatarSilhouette,
  randomBotAvatar,
  withBotAvatarEyeStyle,
  withBotAvatarSilhouette,
} from "@t3tools/client-runtime/bot-avatar";
import type { BotAvatar as BotAvatarParts, ProjectIconColor } from "@t3tools/contracts";
import { CheckIcon, DicesIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { PROJECT_ICON_COLORS } from "../../projectIconOptions";
import { BotAvatar } from "../BotAvatar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SILHOUETTE_LABELS = {
  blob: "Blob",
  squircle: "Squircle",
  pebble: "Pebble",
  drop: "Drop",
  mushroom: "Mushroom",
  cat: "Cat",
  peak: "Peak",
  gem: "Gem",
  heart: "Heart",
  flower: "Flower",
  star: "Star",
  cloud: "Cloud",
  ghost: "Ghost",
  bean: "Bean",
} as const;

const EYE_LABELS = {
  dashes: "Dash eyes",
  dots: "Dot eyes",
  happy: "Happy eyes",
  wink: "Wink",
  sleepy: "Sleepy eyes",
} as const;

const cellClassName = (selected: boolean) =>
  cn(
    "grid size-10 place-items-center rounded-lg outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
    selected ? "bg-accent inset-ring inset-ring-foreground/25" : "hover:bg-accent/60",
  );

function PickerRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-10 shrink-0 pt-3 text-xs text-muted-foreground">{label}</span>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-7 gap-1">
        {children}
      </div>
    </div>
  );
}

/** Picks a bot's shape and eyes; each choice shows the bot wearing it in its color. */
export function BotAvatarPicker({
  value,
  color,
  onChange,
}: {
  readonly value: BotAvatarParts;
  readonly color: ProjectIconColor;
  readonly onChange: (avatar: BotAvatarParts) => void;
}) {
  const silhouette = botAvatarSilhouette(value);
  const eyes = botAvatarEyeStyle(value);
  return (
    <div className="space-y-2">
      <PickerRow label="Shape">
        {BOT_AVATAR_SILHOUETTES.map((option) => {
          const avatar = withBotAvatarSilhouette(value, option);
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={option === silhouette}
              aria-label={SILHOUETTE_LABELS[option]}
              className={cellClassName(option === silhouette)}
              onClick={() => onChange(avatar)}
            >
              <BotAvatar avatar={avatar} color={color} size={30} />
            </button>
          );
        })}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Shuffle"
                className={cn(cellClassName(false), "text-muted-foreground hover:text-foreground")}
                onClick={() => onChange(randomBotAvatar())}
              />
            }
          >
            <DicesIcon aria-hidden className="size-4.5" />
          </TooltipTrigger>
          <TooltipPopup>Shuffle</TooltipPopup>
        </Tooltip>
      </PickerRow>
      <PickerRow label="Eyes">
        {BOT_AVATAR_EYE_STYLES.map((option) => {
          const avatar = withBotAvatarEyeStyle(value, option);
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={option === eyes}
              aria-label={EYE_LABELS[option]}
              className={cellClassName(option === eyes)}
              onClick={() => onChange(avatar)}
            >
              <BotAvatar avatar={avatar} color={color} size={30} />
            </button>
          );
        })}
      </PickerRow>
    </div>
  );
}

/** The project colors as swatches. */
export function BotColorPicker({
  value,
  onChange,
}: {
  readonly value: ProjectIconColor;
  readonly onChange: (color: ProjectIconColor) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-1.5">
      {PROJECT_ICON_COLORS.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            className={cn(
              "grid size-6 place-items-center rounded-full text-white outline-none hover:opacity-85 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground",
              option.swatchClassName,
            )}
            onClick={() => onChange(option.value)}
          >
            {selected ? <CheckIcon aria-hidden className="size-3.5" strokeWidth={3} /> : null}
          </button>
        );
      })}
    </div>
  );
}
