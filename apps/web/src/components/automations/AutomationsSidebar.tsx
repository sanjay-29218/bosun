import {
  isAutomationFailureUnseen,
  type AutomationEntry,
} from "@t3tools/client-runtime/state/automations";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { CalendarClockIcon, PlusIcon } from "lucide-react";
import { memo } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import {
  useAutomationGroups,
  useRunningAutomationKeys,
  useScheduledTaskCreationEnvironmentId,
  useScheduledTasksByEnvironment,
} from "../../state/automations";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../../state/environments";
import { useUiStateStore } from "../../uiStateStore";
import { BotAvatar } from "../BotAvatar";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { ScheduledRelativeLabel, scheduleLabel } from "./ScheduledTaskEditor";

/**
 * The sidebar column on the Automations destination: every shown environment's scheduled
 * tasks, grouped by bot.
 */
export function AutomationsSidebar() {
  const groups = useAutomationGroups();
  const states = useScheduledTasksByEnvironment();
  const running = useRunningAutomationKeys();
  const seen = useUiStateStore((store) => store.seenAutomationFailureAtByKey);
  const identities = useEnvironmentIdentities();
  const connected = useConnectedEnvironmentIds();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const selected = useSearch({
    strict: false,
    select: (search) =>
      typeof search.environmentId === "string" && typeof search.taskId === "string"
        ? `${search.environmentId}:${search.taskId}`
        : null,
  });
  const canCreate = useScheduledTaskCreationEnvironmentId(null) !== null;
  const labelById = new Map(identities.map((identity) => [identity.environmentId, identity.label]));
  const showEnvironment = states.length > 1;
  const loading = states.some((state) => state.tasks === null && state.error === null);
  const errors = states.filter((state) => state.error !== null);
  const empty = groups.length === 0;

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <div className="flex items-center gap-1">
              <h2 className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-sm font-medium text-sidebar-foreground">
                <CalendarClockIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
                Automations
              </h2>
              <SidebarHeaderIconButton
                label="New task"
                disabled={!canCreate}
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                  void navigate({ to: "/automations", search: { new: true } });
                }}
              >
                <PlusIcon className="size-4" />
              </SidebarHeaderIconButton>
            </div>
          </SidebarGroup>
        }
      >
        <SidebarGroup>
          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <section key={group.key} aria-label={group.bot?.name ?? "Tasks"}>
                {group.bot ? (
                  <h3 className="flex items-center gap-2 px-2 pb-1 text-xs font-medium text-muted-foreground">
                    <BotAvatar avatar={group.bot.avatar} color={group.bot.color} size="xs" />
                    <span className="truncate">{group.bot.name}</span>
                  </h3>
                ) : null}
                <ul className="flex flex-col gap-0.5">
                  {group.entries.map((entry) => (
                    <AutomationRow
                      key={entry.key}
                      entry={entry}
                      selected={entry.key === selected}
                      running={running.has(entry.key)}
                      unseenFailure={isAutomationFailureUnseen(entry.task, seen[entry.key])}
                      environmentLabel={
                        showEnvironment ? (labelById.get(entry.environmentId) ?? null) : null
                      }
                      onOpen={() => {
                        if (isMobile) setOpenMobile(false);
                      }}
                    />
                  ))}
                </ul>
              </section>
            ))}
            {empty && !loading && errors.length === 0 ? (
              <p className="px-2 text-xs text-muted-foreground">
                {connected.length === 0 ? "No environments connected" : "No scheduled tasks yet"}
              </p>
            ) : null}
            {loading ? (
              <p className="px-2 text-xs text-muted-foreground" role="status">
                Loading scheduled tasks…
              </p>
            ) : null}
            {errors.map((state) => (
              <p key={state.environmentId} className="px-2 text-xs text-destructive" role="status">
                Could not load {labelById.get(state.environmentId) ?? "an environment"}'s tasks:{" "}
                {state.error}
              </p>
            ))}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

/** One task: its name, then cadence and next run. A dot shows a failure nobody has opened. */
const AutomationRow = memo(function AutomationRow({
  entry,
  selected,
  running,
  unseenFailure,
  environmentLabel,
  onOpen,
}: {
  readonly entry: AutomationEntry;
  readonly selected: boolean;
  readonly running: boolean;
  readonly unseenFailure: boolean;
  readonly environmentLabel: string | null;
  readonly onOpen: () => void;
}) {
  const { task } = entry;
  const status = running
    ? "Running now"
    : !task.enabled
      ? "Paused"
      : task.schedule.type === "webhook"
        ? null
        : task.nextRunAt
          ? "next"
          : "Not scheduled";
  return (
    <li>
      <Link
        to="/automations"
        search={{ environmentId: entry.environmentId, taskId: task.id }}
        aria-current={selected ? "page" : undefined}
        aria-label={unseenFailure ? `${task.title}, last run failed` : undefined}
        onClick={onOpen}
        className={cn(
          "flex min-w-0 flex-col rounded-md px-2 py-1.5 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected && "bg-sidebar-row-selected",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm text-sidebar-foreground",
              !task.enabled && "text-muted-foreground",
            )}
          >
            {task.title}
          </span>
          {unseenFailure ? (
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-error" />
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="truncate">
            {scheduleLabel(task.schedule)}
            {status === null ? null : status === "next" ? (
              <>
                {" · next "}
                <ScheduledRelativeLabel value={task.nextRunAt} />
              </>
            ) : (
              <span className={cn(running && "text-info")}>{` · ${status}`}</span>
            )}
          </span>
          {environmentLabel ? (
            <span className="ms-auto shrink-0 truncate">{environmentLabel}</span>
          ) : null}
        </span>
      </Link>
    </li>
  );
});
