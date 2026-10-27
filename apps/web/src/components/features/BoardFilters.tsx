import { ListFilterIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

export interface BoardFilterSection {
  readonly label: string;
  readonly options: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly checked: boolean;
  }>;
  readonly onChange: (value: string, checked: boolean) => void;
}

const activeCount = (sections: ReadonlyArray<BoardFilterSection>) =>
  sections.reduce(
    (total, section) => total + section.options.filter((option) => option.checked).length,
    0,
  );

/** Every way the board narrows, in one menu. Nothing checked in a section is all of it. */
export function BoardFilterMenu(props: {
  readonly sections: ReadonlyArray<BoardFilterSection>;
  readonly onClear: () => void;
}) {
  const sections = props.sections.filter((section) => section.options.length > 0);
  if (sections.length === 0) return null;
  const active = activeCount(sections);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="sm" variant={active > 0 ? "secondary" : "ghost"} aria-label="Filter" />
        }
      >
        <ListFilterIcon aria-hidden />
        <span className="hidden md:inline">Filter</span>
        {active > 0 ? <span className="tabular-nums">{active}</span> : null}
      </MenuTrigger>
      <MenuPopup align="end">
        {sections.map((section, index) => (
          <MenuGroup key={section.label}>
            {index > 0 ? <MenuSeparator /> : null}
            <MenuGroupLabel>{section.label}</MenuGroupLabel>
            {section.options.map((option) => (
              <MenuCheckboxItem
                key={option.value}
                checked={option.checked}
                onCheckedChange={(checked) => section.onChange(option.value, checked)}
              >
                {option.label}
              </MenuCheckboxItem>
            ))}
          </MenuGroup>
        ))}
        {active > 0 ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={props.onClear}>Clear filters</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** The filters in effect, each removable. Absent while nothing narrows the board. */
export function BoardFilterChips(props: {
  readonly sections: ReadonlyArray<BoardFilterSection>;
  readonly onClear: () => void;
}) {
  const chips = props.sections.flatMap((section) =>
    section.options.filter((option) => option.checked).map((option) => ({ section, option })),
  );
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      {chips.map(({ section, option }) => (
        <span
          key={`${section.label}:${option.value}`}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-border/70 ps-2 pe-0.5"
        >
          <span className="text-muted-foreground">{section.label}</span>
          {option.label}
          <button
            type="button"
            aria-label={`Remove ${section.label} ${option.label}`}
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => section.onChange(option.value, false)}
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </span>
      ))}
      {chips.length > 1 ? (
        <Button size="xs" variant="ghost" onClick={props.onClear}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}
