import { ChevronLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { SettingsPageContainer } from "./settingsLayout";

/**
 * A Crew settings page (Bots, Workflows, Roles): its title and actions over the list, or over
 * one item's editor with a way back to the list.
 */
export function CrewSettingsFrame({
  back,
  title,
  badge,
  actions,
  children,
}: {
  readonly back: { readonly label: string; readonly onBack: () => void } | null;
  readonly title: string;
  readonly badge?: ReactNode;
  readonly actions: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-1.5 px-3 sm:px-4">
        {back ? (
          <div className="-ms-2 flex">
            <Button size="xs" variant="ghost-muted" onClick={back.onBack}>
              <ChevronLeftIcon />
              {back.label}
            </Button>
          </div>
        ) : null}
        <div className="flex min-h-8 min-w-0 items-center gap-2">
          <h2 className="truncate text-base font-semibold text-foreground">{title}</h2>
          {badge}
          <div className="ms-auto flex shrink-0 items-center gap-1.5">{actions}</div>
        </div>
      </div>
      {children}
    </SettingsPageContainer>
  );
}
