import { CREW_TOOL_GRANTS } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";

const KNOWN_TOOLS: ReadonlySet<string> = new Set(CREW_TOOL_GRANTS.map((grant) => grant.id));
const T3_TOOLKITS = CREW_TOOL_GRANTS.filter((grant) => !grant.id.startsWith("crew."));

/**
 * The tools a bot or role may use, as a checklist: ticked is granted. `value` holds the ones
 * withheld, so a tool added later starts ticked. Withheld ids this version doesn't know stay
 * listed, unticked, so they can be granted back.
 */
export function CrewToolPicker({
  value,
  onChange,
  forBot = false,
}: {
  readonly value: ReadonlyArray<string>;
  readonly onChange: (next: ReadonlyArray<string>) => void;
  /** Bots also get the grants for managing bots, roles and workflows. */
  readonly forBot?: boolean;
}) {
  const other = value
    .filter((id) => !KNOWN_TOOLS.has(id))
    .map((id) => ({ id, label: id, description: "A tool this version doesn't know." }));
  const noToolkits = T3_TOOLKITS.every((grant) => value.includes(grant.id));
  const groups = [
    {
      title: "Crew",
      note: null,
      grants: CREW_TOOL_GRANTS.filter(
        (grant) => grant.id.startsWith("crew.") && (forBot || !("botOnly" in grant)),
      ),
    },
    {
      title: "T3 Code tools",
      note: noToolkits ? "No T3 Code tools: this agent can't use any." : null,
      grants: [...T3_TOOLKITS, ...other],
    },
  ].filter((group) => group.grants.length > 0);
  const toggle = (id: string, granted: boolean) =>
    onChange(granted ? value.filter((candidate) => candidate !== id) : [...value, id]);

  return (
    <div className="@container/tools space-y-3">
      {groups.map((group) => (
        <div key={group.title} className="space-y-1">
          <div className="px-2.5 text-xs font-medium text-muted-foreground">{group.title}</div>
          {group.note === null ? null : (
            <div className="px-2.5 text-xs text-muted-foreground">{group.note}</div>
          )}
          <div className="grid gap-0.5 @md/tools:grid-cols-2 @3xl/tools:grid-cols-3">
            {group.grants.map((grant) => {
              const checked = !value.includes(grant.id);
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

/** A labeled block of a bot or role editor. */
export function EditorField({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    // A grid, so an inline control (the model picker) still sits under its label.
    <div className="grid gap-2">
      <Label {...(htmlFor ? { htmlFor } : {})}>{label}</Label>
      {children}
    </div>
  );
}
