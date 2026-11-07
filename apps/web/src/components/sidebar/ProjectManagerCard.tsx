import { botAvatarPalette } from "@t3tools/client-runtime/bot-avatar";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectManagerLook } from "@t3tools/client-runtime/project-manager-look";
import { projectHeadquartersThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { memo, type CSSProperties } from "react";

import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { ProjectManagerAvatar, useProjectManagerIcon } from "../bots/ProjectManagerIcon";
import { searchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type ScopedProjectManager,
  useOpenProjectManager,
  useScopedProjectManager,
} from "./openProjectManager";
import { useStandingStatus } from "./useStandingStatus";

/** The card for the project the thread list is scoped to, when it has a manager. */
export function ScopedProjectManagerCard() {
  const manager = useScopedProjectManager();
  return manager ? <ProjectManagerCard manager={manager} /> : null;
}

/**
 * The scoped project's manager at the top of the thread list, tinted in its color: its status,
 * its latest message, and a way to its settings. Its thread is off the list, so this is how it
 * opens.
 */
const ProjectManagerCard = memo(function ProjectManagerCard({
  manager,
}: {
  readonly manager: ScopedProjectManager;
}) {
  const openProjectManager = useOpenProjectManager();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const icon = useProjectManagerIcon(manager.environmentId, manager.projectId);
  const threadId = projectHeadquartersThreadId(manager.projectId);
  const ref = scopeThreadRef(manager.environmentId, threadId);
  const shell = useThreadShell(ref);
  const { waiting, working, done, status } = useStandingStatus(ref);
  const open = useParams({ strict: false, select: (params) => params.threadId === threadId });
  const preview = shell?.source.latestVisibleMessage?.text;
  const tint = botAvatarPalette(projectManagerLook(manager.projectId, icon).color).base;

  return (
    <div className="pb-2">
      <div
        data-open={open ? "" : undefined}
        style={{ "--pm-tint": tint } as CSSProperties}
        className={cn(
          "group/pm-card relative flex items-center gap-2.5 rounded-xl border px-2.5 py-2 transition-colors",
          open
            ? "border-(--pm-tint)/35 bg-(--pm-tint)/15"
            : "border-(--pm-tint)/18 bg-(--pm-tint)/9 hover:bg-(--pm-tint)/13",
        )}
      >
        <button
          type="button"
          aria-label={`Open ${manager.title}'s project manager${status ? `, ${status}` : ""}`}
          aria-current={open ? "page" : undefined}
          className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => {
            if (isMobile) setOpenMobile(false);
            void openProjectManager(manager);
          }}
        />
        <ProjectManagerAvatar
          projectId={manager.projectId}
          icon={icon}
          size={36}
          working={working}
          className="pointer-events-none shrink-0"
        />
        <div className="pointer-events-none flex min-w-0 flex-1 flex-col">
          {/* The title has the top line to itself; the status leads the second. */}
          <span className="truncate pe-6 text-sm font-medium text-sidebar-foreground">
            Project manager
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            {waiting ? (
              <span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-2xs leading-4 font-medium text-warning-foreground">
                Needs you
              </span>
            ) : working ? (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-info/15 px-1.5 text-2xs leading-4 font-medium text-info-foreground">
                <span aria-hidden className="size-[5px] rounded-full bg-info" />
                Working
              </span>
            ) : done ? (
              <span className="shrink-0 rounded-full bg-success/15 px-1.5 text-2xs leading-4 font-medium text-success-foreground">
                Done
              </span>
            ) : null}
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {preview ? `${manager.title} · ${preview}` : manager.title}
            </span>
          </span>
        </div>
        <span className="pointer-events-auto absolute end-1.5 top-1.5 opacity-0 group-hover/pm-card:opacity-100 focus-within:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label="Project manager settings"
                  onClick={() => {
                    if (isMobile) setOpenMobile(false);
                    void navigate({
                      to: "/settings/projects",
                      search: { project: manager.projectKey },
                      hash: searchableSetting("project-manager").id,
                    });
                  }}
                />
              }
            >
              <SettingsIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Project manager settings</TooltipPopup>
          </Tooltip>
        </span>
      </div>
    </div>
  );
});
