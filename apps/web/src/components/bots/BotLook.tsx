import { randomBotAvatar } from "@t3tools/client-runtime/bot-avatar";
import {
  BOT_EYES,
  BOT_FACES,
  BOT_HEADS,
  BOT_TOPS,
  type BotAvatar as BotAvatarParts,
  type ProjectIconColor,
} from "@t3tools/contracts";
import { CheckIcon, DicesIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { PROJECT_ICON_COLORS } from "../../projectIconOptions";
import { BotAvatar } from "../BotAvatar";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";

const PART_LABELS = {
  head: {
    squircle: "Square head",
    round: "Round head",
    wide: "Wide head",
    tall: "Tall head",
    dome: "Dome head",
    cat: "Cat head",
    peak: "Peak head",
    gem: "Gem head",
  },
  face: { visor: "Visor", plate: "Face plate", bare: "Bare face", flat: "Flat" },
  eyes: {
    round: "Round eyes",
    happy: "Happy eyes",
    wink: "Wink",
    sleepy: "Sleepy eyes",
    star: "Star eyes",
    tall: "Tall eyes",
    visor: "Eye bar",
    heart: "Heart eyes",
    big: "Big eyes",
    dash: "Dash eyes",
  },
  top: {
    ball: "Antenna",
    double: "Two antennas",
    ears: "Side pods",
    sprout: "Sprout",
    propeller: "Propeller",
    headphones: "Headphones",
    bow: "Bow",
    halo: "Halo",
    horns: "Horns",
    none: "Nothing on top",
  },
} as const;

/** Builds a bot's avatar part by part; each choice shows the bot wearing it. */
export function BotAvatarPicker({
  value,
  color,
  onChange,
}: {
  readonly value: BotAvatarParts;
  readonly color: ProjectIconColor;
  readonly onChange: (avatar: BotAvatarParts) => void;
}) {
  const parts = [
    { key: "head", label: "Head", options: BOT_HEADS },
    { key: "face", label: "Face", options: BOT_FACES },
    { key: "eyes", label: "Eyes", options: BOT_EYES },
    { key: "top", label: "Top", options: BOT_TOPS },
  ] as const;
  return (
    <div className="space-y-2">
      {parts.map((part) => (
        <div key={part.key} className="flex items-center gap-3">
          <span className="w-10 shrink-0 text-xs text-muted-foreground">{part.label}</span>
          <div role="radiogroup" aria-label={part.label} className="flex flex-wrap gap-1">
            {part.options.map((option) => {
              const selected = value[part.key] === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={(PART_LABELS[part.key] as Record<string, string>)[option]}
                  className={cn(
                    "grid size-10 place-items-center rounded-lg outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    selected
                      ? "bg-accent inset-ring inset-ring-foreground/25"
                      : "hover:bg-accent/60",
                  )}
                  onClick={() => onChange({ ...value, [part.key]: option })}
                >
                  <BotAvatar avatar={{ ...value, [part.key]: option }} color={color} size={34} />
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1.5 pt-1 sm:pl-13">
        <Toggle
          variant="outline"
          size="compact"
          pressed={value.cheeks}
          onPressedChange={(cheeks) => onChange({ ...value, cheeks })}
        >
          Cheeks
        </Toggle>
        <Toggle
          variant="outline"
          size="compact"
          pressed={value.smile}
          onPressedChange={(smile) => onChange({ ...value, smile })}
        >
          Smile
        </Toggle>
        <Button variant="ghost-muted" size="xs" onClick={() => onChange(randomBotAvatar())}>
          <DicesIcon />
          Shuffle
        </Button>
      </div>
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
