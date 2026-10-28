import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const CHOICES = [1, 2, 3, 5, 10];
const NO_LIMIT = "none";

const limitText = (limit: number) => (limit === 1 ? "Once" : `${limit} times`);

/** How many times a route back to an earlier stage may be taken before the feature asks you. */
export function RouteLimitSelect({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly onChange: (limit: number | null) => void;
}) {
  const choices =
    value === null || CHOICES.includes(value)
      ? CHOICES
      : [...CHOICES, value].toSorted((a, b) => a - b);
  return (
    <Select
      value={value === null ? NO_LIMIT : String(value)}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next === NO_LIMIT ? null : Number(next));
      }}
    >
      <Tooltip>
        <TooltipTrigger render={<SelectTrigger size="sm" aria-label={label} />}>
          <SelectValue>
            {(next: string) => (next === NO_LIMIT ? "No limit" : limitText(Number(next)))}
          </SelectValue>
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-56">
          After this many loops, the feature stops at Your call.
        </TooltipPopup>
      </Tooltip>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value={NO_LIMIT}>No limit</SelectItem>
        {choices.map((limit) => (
          <SelectItem key={limit} value={String(limit)}>
            {limitText(limit)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
