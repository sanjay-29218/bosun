import { useAtomValue } from "@effect/atom-react";
import {
  automationKey,
  createAutomationRunIndex,
  isAutomationFailureUnseen,
} from "@t3tools/client-runtime/state/automations";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useScheduledTasksByEnvironment } from "../../state/automations";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { useUiStateStore } from "../../uiStateStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  ScheduledRelativeLabel,
  ScheduledTaskActions,
  ScheduledTaskEditorForm,
  scheduleLabel,
} from "./ScheduledTaskEditor";
import type { AutomationsSearch } from "./scheduledTaskEditor.logic";

const RECENT_RUN_LIMIT = 10;

/** The Automations destination's main pane: the selected task's runs and editor, or a new task. */
export function AutomationsPage(search: AutomationsSearch) {
  const navigate = useNavigate();
  const states = useScheduledTasksByEnvironment();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const defaultEnvironmentId =
    search.environmentId ??
    connectedEnvironmentIds.find((environmentId) => environmentId === primaryEnvironmentId) ??
    connectedEnvironmentIds[0] ??
    null;
  const canCreate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(defaultEnvironmentId),
  );
  // An editor's environment can drop out while the user edits; keep showing the last copy
  // of its task so a disconnect doesn't throw away unsaved changes.
  const selectedKey =
    search.taskId === undefined || search.environmentId === undefined
      ? null
      : automationKey(search.environmentId, search.taskId);
  const selectedState = states.find((state) => state.environmentId === search.environmentId);
  const liveTask = selectedState?.tasks?.find((task) => task.id === search.taskId) ?? null;
  const [kept, setKept] = useState<{ key: string; task: ScheduledTask } | null>(null);
  if (selectedKey !== null && liveTask !== null && kept?.task !== liveTask) {
    setKept({ key: selectedKey, task: liveTask });
  }
  const task = liveTask ?? (kept !== null && kept.key === selectedKey ? kept.task : null);
  const taskMissing =
    selectedKey !== null && task === null && (selectedState?.tasks ?? null) !== null;

  // Opening a task is what sees its failure, like opening a thread.
  const markFailureSeen = useUiStateStore((store) => store.markAutomationFailureSeen);
  const seenFailedRunAt = useUiStateStore((store) =>
    selectedKey === null ? undefined : store.seenAutomationFailureAtByKey[selectedKey],
  );
  const unseenFailedRunAt =
    liveTask !== null && isAutomationFailureUnseen(liveTask, seenFailedRunAt)
      ? liveTask.lastRunAt
      : null;
  // oxlint-disable-next-line t3code/react-effect-budget -- records the shown failure in the persisted UI store, outside React.
  useEffect(() => {
    if (selectedKey !== null && unseenFailedRunAt !== null) {
      markFailureSeen(selectedKey, unseenFailedRunAt);
    }
  }, [markFailureSeen, selectedKey, unseenFailedRunAt]);

  // Bumped to remount the form, which discards its draft.
  const [formRevision, setFormRevision] = useState(0);
  const openTask = (environmentId: EnvironmentId, saved: ScheduledTask) =>
    void navigate({
      to: "/automations",
      search: { environmentId, taskId: saved.id },
      replace: search.new === true,
    });
  const closeEditor = () => void navigate({ to: "/automations", search: {} });

  const title = search.new ? "New task" : (task?.title ?? null);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Automations breadcrumb" className="flex-1">
            <WorkspaceBreadcrumbItem current={title === null}>
              {title === null ? <h1>Automations</h1> : "Automations"}
            </WorkspaceBreadcrumbItem>
            {title === null ? null : (
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">{title}</h1>
              </WorkspaceBreadcrumbItem>
            )}
          </WorkspaceBreadcrumb>
          {task !== null && search.environmentId !== undefined && !search.new ? (
            <ScheduledTaskActions
              environmentId={search.environmentId}
              task={task}
              onDeleted={closeEditor}
            />
          ) : null}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            {search.new ? (
              defaultEnvironmentId === null ? (
                <NoEnvironments />
              ) : (
                <ScheduledTaskEditorForm
                  key={`new:${defaultEnvironmentId}:${formRevision}`}
                  initialEnvironmentId={defaultEnvironmentId}
                  task={null}
                  onSaved={openTask}
                  onCancel={closeEditor}
                />
              )
            ) : task !== null && search.environmentId !== undefined ? (
              <>
                <TaskStatus task={task} />
                <RecentRuns environmentId={search.environmentId} task={task} />
                <section aria-labelledby="automation-settings-heading" className="space-y-3">
                  <h2 id="automation-settings-heading" className="text-sm font-medium">
                    Settings
                  </h2>
                  <ScheduledTaskEditorForm
                    key={`${selectedKey}:${formRevision}`}
                    initialEnvironmentId={search.environmentId}
                    task={task}
                    onSaved={() => {}}
                    onCancel={() => setFormRevision((revision) => revision + 1)}
                  />
                </section>
              </>
            ) : taskMissing ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Task unavailable</EmptyTitle>
                  <EmptyDescription>This task no longer exists.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : selectedKey !== null ? (
              <p className="text-sm text-muted-foreground" role="status">
                Loading task…
              </p>
            ) : connectedEnvironmentIds.length === 0 ? (
              <NoEnvironments />
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CalendarClockIcon />
                  </EmptyMedia>
                  <EmptyTitle>Run prompts on a schedule</EmptyTitle>
                  <EmptyDescription>
                    On an interval, at a fixed time, or when a webhook is called. Pick a task to
                    edit it and see its runs.
                  </EmptyDescription>
                </EmptyHeader>
                <Button
                  size="sm"
                  disabled={defaultEnvironmentId === null || !canCreate}
                  onClick={() => void navigate({ to: "/automations", search: { new: true } })}
                >
                  <PlusIcon />
                  New task
                </Button>
              </Empty>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function NoEnvironments() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CalendarClockIcon />
        </EmptyMedia>
        <EmptyTitle>No environments available</EmptyTitle>
        <EmptyDescription>Connect an environment to manage automations.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const LAST_RUN_BADGE = {
  running: { variant: "info", label: "Running" },
  succeeded: { variant: "success", label: "Started" },
  failed: { variant: "error", label: "Failed" },
} as const;

function TaskStatus({ task }: { readonly task: ScheduledTask }) {
  const badge = task.lastRunStatus === "never" ? null : LAST_RUN_BADGE[task.lastRunStatus];
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {scheduleLabel(task.schedule)} ·{" "}
          {!task.enabled ? (
            "Paused"
          ) : task.schedule.type === "webhook" ? (
            "Listening"
          ) : task.nextRunAt ? (
            <>
              Next run <ScheduledRelativeLabel value={task.nextRunAt} />
            </>
          ) : (
            "Not scheduled"
          )}
        </span>
        {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
      </div>
      {task.lastRunError ? <p className="text-destructive">{task.lastRunError}</p> : null}
    </div>
  );
}

const RUN_STATUS_LABEL: Partial<Record<string, string>> = {
  completed: "Finished",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  rolled_back: "Rolled back",
};

/** The threads the task's runs went to, newest first. Webhook deliveries live in their dialog. */
function RecentRuns({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}) {
  const shells = useAtomValue(environmentThreadShells.threadShellsAtom);
  const runs = createAutomationRunIndex(shells)(environmentId, task).slice(0, RECENT_RUN_LIMIT);
  return (
    <section aria-labelledby="automation-runs-heading" className="space-y-2">
      <h2 id="automation-runs-heading" className="text-sm font-medium">
        {task.threadId === null ? "Recent runs" : "Posts to"}
      </h2>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {task.runCount === 0 ? "No runs yet." : "Its run threads are no longer around."}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border">
          {runs.map((run) => {
            const status = isThreadWorking(run)
              ? "Working"
              : run.archivedAt !== null
                ? "Archived"
                : (RUN_STATUS_LABEL[run.latestRun?.status ?? ""] ?? null);
            return (
              <li key={run.id}>
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId: run.environmentId, threadId: run.id }}
                  className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="min-w-0 flex-1 truncate">{run.title}</span>
                  {status ? (
                    <span
                      className={status === "Failed" ? "text-destructive" : "text-muted-foreground"}
                    >
                      {status}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    <ScheduledRelativeLabel value={run.latestRun?.requestedAt ?? run.createdAt} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
