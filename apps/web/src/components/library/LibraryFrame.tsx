import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

/**
 * A rail place's main pane (the Library's unless `root` names another): a breadcrumb header
 * with the page's actions, over its content.
 */
export function LibraryFrame({
  root = "Library",
  title,
  badge,
  actions,
  children,
}: {
  readonly root?: string;
  readonly title: string | null;
  readonly badge?: ReactNode;
  readonly actions: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel={`${root} breadcrumb`} className="flex-1">
            <WorkspaceBreadcrumbItem current={title === null}>
              {title === null ? <h1>{root}</h1> : root}
            </WorkspaceBreadcrumbItem>
            {title === null ? null : (
              <WorkspaceBreadcrumbItem current>
                <span className="flex min-w-0 items-center gap-2">
                  <h1 className="truncate">{title}</h1>
                  {badge}
                </span>
              </WorkspaceBreadcrumbItem>
            )}
          </WorkspaceBreadcrumb>
          {actions}
        </WorkspacePageHeader>
        {/* The workflow canvas expands to fill this. */}
        <div data-workflow-canvas-host="" className="relative flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">{children}</ScrollArea>
        </div>
      </div>
    </SidebarInset>
  );
}
