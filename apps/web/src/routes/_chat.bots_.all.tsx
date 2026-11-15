import { createFileRoute } from "@tanstack/react-router";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { workspaceAreaProps } from "../lib/workspaceFocus";

// The Bots list lives in the sidebar column; this keeps the main area quiet until a row opens.
function BotsListRouteView() {
  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, "Bots")}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>Bots and project managers</EmptyTitle>
          <EmptyDescription>
            Open one from the list to talk to it. Pin the ones you use to keep them in the rail.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/bots_/all")({
  component: BotsListRouteView,
});
