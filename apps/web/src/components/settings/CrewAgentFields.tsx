import { CREW_TOOL_GRANTS } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import type { RoleMode } from "./RolesSettings";

const KNOWN_TOOLS: ReadonlySet<string> = new Set(CREW_TOOL_GRANTS.map((grant) => grant.id));

/** A grant's name for people; grants this client doesn't know show as stored. */
export function crewToolLabel(id: string): string {
  return CREW_TOOL_GRANTS.find((grant) => grant.id === id)?.label ?? id;
}

/**
 * The tools a bot or role may use, as a checklist. Grants it doesn't know, from an older
 * client or the MCP tools, stay listed so they can still be removed.
 */
export function CrewToolPicker({
  value,
  onChange,
  forBot = false,
}: {
  readonly value: ReadonlyArray<string>;
  readonly onChange: (next: ReadonlyArray<string>) => void;
  /** Bots also get the grants for overseeing the projects they own. */
  readonly forBot?: boolean;
}) {
  const other = value
    .filter((id) => !KNOWN_TOOLS.has(id))
    .map((id) => ({ id, label: id, description: "Granted outside this list." }));
  const groups = [
    {
      title: "Crew",
      grants: CREW_TOOL_GRANTS.filter(
        (grant) => grant.id.startsWith("crew.") && (forBot || !("botOnly" in grant)),
      ),
    },
    {
      title: "T3 Code",
      grants: [...CREW_TOOL_GRANTS.filter((grant) => !grant.id.startsWith("crew.")), ...other],
    },
  ];
  const toggle = (id: string, checked: boolean) =>
    onChange(checked ? [...value, id] : value.filter((candidate) => candidate !== id));

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group.title} className="space-y-1">
          <div className="px-2.5 text-xs font-medium text-muted-foreground">{group.title}</div>
          <div className="grid gap-0.5 sm:grid-cols-2">
            {group.grants.map((grant) => {
              const checked = value.includes(grant.id);
              return (
                <label
                  key={grant.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent",
                    checked && "bg-accent/60",
                  )}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={checked}
                    onCheckedChange={(next) => toggle(grant.id, next === true)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm leading-5">{grant.label}</span>
                    <span className="block text-xs text-muted-foreground">{grant.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

const MODE_DESCRIPTIONS: Record<RoleMode, string> = {
  ask: "Asks you before it edits files or runs commands.",
  act: "Edits files and runs commands without asking.",
};

/** Whether a bot or role asks before acting, with what that means. */
export function CrewModeToggle({
  value,
  onChange,
}: {
  readonly value: RoleMode;
  readonly onChange: (mode: RoleMode) => void;
}) {
  return (
    <div className="space-y-1.5">
      <ToggleGroup
        aria-label="Approvals"
        className="w-full *:flex-1"
        value={[value]}
        onValueChange={(next) => {
          const mode = next[0];
          if (mode === "ask" || mode === "act") onChange(mode);
        }}
      >
        <ToggleGroupItem value="ask">Ask first</ToggleGroupItem>
        <ToggleGroupItem value="act">Act on its own</ToggleGroupItem>
      </ToggleGroup>
      <p className="text-xs text-muted-foreground">{MODE_DESCRIPTIONS[value]}</p>
    </div>
  );
}

/** A labeled block of a bot or role editor. */
export function EditorField({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <Label {...(htmlFor ? { htmlFor } : {})}>{label}</Label>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}
