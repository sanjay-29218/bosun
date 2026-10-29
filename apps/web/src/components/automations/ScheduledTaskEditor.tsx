import { useAtomValue } from "@effect/atom-react";
import {
  CopyIcon,
  InboxIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import type {
  Bot,
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ScheduledTaskWebhookDeliverySummary,
  ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_WEBHOOK_PROMPT,
  emptyWebhookFilterDraft,
  parseWebhookFilterDrafts,
  removeWebhookFilterDraft,
  WEBHOOK_FILTER_OPS,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import {
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MAX_WEBHOOK_FILTERS,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ProviderInstanceId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { formatRelativeTime } from "../../timestampFormat";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { requestConfirmDialog } from "../../confirmDialog";
import { webhookAddress } from "@t3tools/client-runtime/webhook-address";
import { Link } from "@tanstack/react-router";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  useEnvironments,
} from "../../state/environments";
import { useProjects } from "../../state/entities";
import { botsEnvironment } from "../../state/bots";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { BotAvatar } from "../BotAvatar";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { readEnvironmentScope } from "~/state/session";
import { isConnectedWithConfig } from "../settings/scopedSettings";
import { settingsScopeEnvironmentLabels } from "../settings/settingsScopeAxis";
import {
  WEBHOOK_SIGNATURE_DEFAULTS,
  webhookDraftErrors,
  webhookDeliveryLabel,
  runTargetFromDraft,
  scheduleFromDraft,
  scheduledTaskDefaultModel,
  taskToDraft,
  type DraftState,
  type ScheduleMode,
  type WorkspaceMode,
} from "./scheduledTaskEditor.logic";
import { Label } from "../ui/label";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { DisclosureSection } from "../DisclosureSection";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { InstructionsEditor } from "../InstructionsEditor";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: "Create a new worktree",
  root: "Use the project checkout",
  existing_worktree: "Use a specific checkout",
};

const EMPTY_DRAFT: DraftState = {
  editingId: null,
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
  botId: "",
  projectId: "",
  threadId: "",
  workspaceMode: "worktree",
  baseRef: "main",
  startFromOrigin: true,
  existingWorktreePath: "",
  modelKey: "",
  runtimeMode: "full-access",
  interactionMode: "default",
  baseModelSelection: null,
  signatureEnabled: false,
  ...WEBHOOK_SIGNATURE_DEFAULTS,
  signatureSecret: "",
  maxDeliveryAgeMinutes: "",
  replayKey: "",
  coalesceKey: "",
  coalesceWindowSeconds: "",
  filters: [],
  savedFilters: [],
};

function WebhookFiltersField({
  filters,
  onChange,
}: {
  filters: ReadonlyArray<WebhookFilterDraft>;
  onChange: (filters: ReadonlyArray<WebhookFilterDraft>) => void;
}) {
  const update = (index: number, patch: Partial<WebhookFilterDraft>) =>
    onChange(filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <Label>Filters</Label>
          <p className="text-sm text-muted-foreground">
            Run only when every filter matches. Other requests are logged as filtered. Separate “is
            one of” values with commas; a value can't contain a comma.
          </p>
        </div>
        <Button
          className="shrink-0"
          variant="outline"
          size="sm"
          disabled={filters.length >= MAX_WEBHOOK_FILTERS}
          onClick={() => onChange([...filters, emptyWebhookFilterDraft()])}
        >
          <PlusIcon />
          Add filter
        </Button>
      </div>
      {filters.map((filter, index) => (
        // Always stacked: the dialog stays narrow on wide windows, so a single line
        // would cut off typical paths and values. The grid wrappers size each control
        // without restyling it; a grid item stretches to its minmax(0, 1fr) track.
        <div key={filter.id} className="space-y-2 pt-1">
          <div className="flex items-center gap-2">
            <div className="grid min-w-0 flex-1 grid-cols-1">
              <Input
                aria-label={`Filter ${index + 1} path`}
                placeholder="body.action"
                value={filter.path}
                onChange={(event) => update(index, { path: event.target.value })}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove filter ${index + 1}`}
              onClick={() => onChange(removeWebhookFilterDraft(filters, filter.id))}
            >
              <Trash2Icon />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={filter.op}
              onValueChange={(op) => {
                const known = WEBHOOK_FILTER_OPS.find((option) => option.op === op);
                if (known) update(index, { op: known.op });
              }}
            >
              <div className="grid w-44 shrink-0 grid-cols-1">
                <SelectTrigger size="sm" aria-label={`Filter ${index + 1} test`}>
                  <SelectValue>
                    {WEBHOOK_FILTER_OPS.find((option) => option.op === filter.op)?.label}
                  </SelectValue>
                </SelectTrigger>
              </div>
              <SelectPopup>
                {WEBHOOK_FILTER_OPS.map((option) => (
                  <SelectItem key={option.op} value={option.op}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {filter.op === "exists" ? null : (
              <div className="grid min-w-0 flex-1 grid-cols-1">
                <Input
                  aria-label={`Filter ${index + 1} value`}
                  placeholder={filter.op === "in" ? "opened, reopened" : "opened"}
                  value={filter.value}
                  onChange={(event) => update(index, { value: event.target.value })}
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

const NEW_THREAD_RUN = "thread";

function RunsAsOption({ bot }: { readonly bot: Pick<Bot, "name" | "avatar" | "color"> | null }) {
  if (bot === null) return <>A new thread in a project</>;
  return (
    <span className="flex items-center gap-2">
      <BotAvatar avatar={bot.avatar} color={bot.color} size="xs" />
      {bot.name}
    </span>
  );
}

function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

export function scheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/** formatRelativeTime handles only the past; upcoming runs need future labels. */
function relativeLabel(value: string | null, nowMs: number): string {
  if (!value) return "Not scheduled";
  const diffMs = new Date(value).getTime() - nowMs;
  if (diffMs <= 0) {
    const relative = formatRelativeTime(value, nowMs);
    if (!relative) return "Not scheduled";
    return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
  }
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

// Use the label's minute tick because the compiler caches render-time Date.now() on the timestamp.
export function ScheduledRelativeLabel(props: { value: string | null }) {
  const nowMinute = useNowMinute();
  return relativeLabel(props.value, Date.parse(`${nowMinute}:00.000Z`));
}

function deliveryOutcomeVariant(outcome: string) {
  if (outcome === "accepted") return "success";
  if (
    outcome === "duplicate" ||
    outcome === "coalesced" ||
    outcome === "disabled" ||
    outcome === "rate_limited" ||
    outcome === "expired"
  ) {
    return "warning";
  }
  if (outcome === "dispatch_failed" || outcome === "rejected_signature") return "error";
  return "outline";
}

/** Run now, webhook deliveries and delete, for the task the Automations page shows. */
export function ScheduledTaskActions({
  environmentId,
  task,
  onDeleted,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onDeleted: () => void;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [deliveriesOpen, setDeliveriesOpen] = useState(false);
  const isWebhook = task.schedule.type === "webhook";
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task set enabled",
  });
  const act = async (action: "run" | "toggle" | "delete") => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    if (action === "delete") {
      const confirmed =
        (await requestConfirmDialog(`Delete "${task.title}"?`, { variant: "destructive" })) ??
        window.confirm(`Delete "${task.title}"?`);
      if (!confirmed) return;
    }
    setBusy(true);
    const result =
      action === "run"
        ? await run({ environmentId, input: { id: task.id } })
        : action === "toggle"
          ? await setEnabled({ environmentId, input: { id: task.id, enabled: !task.enabled } })
          : await remove({ environmentId, input: { id: task.id } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update scheduled task",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
      return;
    }
    if (action === "delete") onDeleted();
  };
  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="outline"
        disabled={busy || !canOperate}
        onClick={() => void act("toggle")}
      >
        {task.enabled ? <PauseIcon /> : <PlayIcon />}
        {task.enabled ? "Pause" : "Resume"}
      </Button>
      {isWebhook ? (
        <Button size="xs" variant="outline" onClick={() => setDeliveriesOpen(true)}>
          <InboxIcon />
          Deliveries
        </Button>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !canOperate || task.lastRunStatus === "running"}
          onClick={() => void act("run")}
        >
          <ZapIcon />
          Run now
        </Button>
      )}
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={busy || !canOperate}
              aria-label={`Actions for ${task.title}`}
            />
          }
        >
          <MoreHorizontalIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem variant="destructive" onClick={() => void act("delete")}>
            <Trash2Icon />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
      {deliveriesOpen ? (
        <WebhookDeliveriesDialog
          environmentId={environmentId}
          task={task}
          onClose={() => setDeliveriesOpen(false)}
        />
      ) : null}
    </div>
  );
}

function WebhookDeliveriesDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onClose: () => void;
}) {
  const deliveriesQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTaskWebhookDeliveries({
      environmentId,
      input: { id: task.id, acceptAnyOutcome: true },
    }),
  );
  const [selectedId, setSelectedId] = useState<ScheduledTaskWebhookDeliverySummary["id"] | null>(
    null,
  );
  const selectedQuery = useEnvironmentQuery(
    selectedId === null
      ? null
      : serverEnvironment.scheduledTaskWebhookDelivery({
          environmentId,
          input: { id: task.id, deliveryId: selectedId, acceptAnyOutcome: true },
        }),
  );
  const deliveries = deliveriesQuery.data?.deliveries ?? null;
  const selected = selectedQuery.data?.delivery ?? null;
  const error = selectedId === null ? deliveriesQuery.error : selectedQuery.error;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deliveries · {task.title}</DialogTitle>
          <DialogDescription>Recent requests to this task's webhook URL.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {selectedId !== null && selected === null && selectedQuery.error === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading delivery…
            </p>
          ) : selected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge
                  variant={deliveryOutcomeVariant(
                    selected.pendingWindow ? "coalesced" : selected.outcome,
                  )}
                >
                  {webhookDeliveryLabel(selected)}
                </Badge>
                <span>
                  {selected.method} · <ScheduledRelativeLabel value={selected.receivedAt} />
                </span>
                {selected.signatureVerified ? (
                  <span className="text-muted-foreground">Signature verified</span>
                ) : null}
              </div>
              {selected.error ? (
                <p
                  className={
                    selected.outcome === "filtered"
                      ? "text-sm text-muted-foreground"
                      : "text-sm text-destructive"
                  }
                >
                  {selected.error}
                </p>
              ) : null}
              <DeliveryBlock
                title={selected.pendingWindow ? "Scheduled run" : "Prompt sent to the agent"}
              >
                {selected.renderedPrompt ??
                  (selected.pendingWindow
                    ? "Run scheduled when the window closes; no run started yet."
                    : "No run was started for this request.")}
              </DeliveryBlock>
              {selected.missingFields.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Empty placeholders: {selected.missingFields.join(", ")}
                </p>
              ) : null}
              <DeliveryBlock title="Headers">
                {Object.entries(selected.headers)
                  .map(([name, value]) => `${name}: ${value}`)
                  .join("\n")}
              </DeliveryBlock>
              {selected.query ? (
                <DeliveryBlock title="Query">{selected.query}</DeliveryBlock>
              ) : null}
              <DeliveryBlock title={selected.bodyTruncated ? "Body (truncated)" : "Body"}>
                {selected.body || "(empty)"}
              </DeliveryBlock>
            </div>
          ) : selectedId !== null ? null : deliveries === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading deliveries…
            </p>
          ) : deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {deliveries.map((delivery) => (
                <li key={delivery.id}>
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-2 py-2 text-left text-sm hover:bg-accent/40"
                    onClick={() => setSelectedId(delivery.id)}
                  >
                    <Badge
                      variant={deliveryOutcomeVariant(
                        delivery.pendingWindow ? "coalesced" : delivery.outcome,
                      )}
                    >
                      {webhookDeliveryLabel(delivery)}
                    </Badge>
                    <span>{delivery.method}</span>
                    <span className="text-muted-foreground">
                      <ScheduledRelativeLabel value={delivery.receivedAt} />
                    </span>
                    {delivery.outcome === "filtered" && delivery.error ? (
                      <span className="text-muted-foreground">{delivery.error}</span>
                    ) : null}
                    {delivery.missingFields.length > 0 ? (
                      <span className="text-muted-foreground">
                        {delivery.missingFields.length} empty placeholder
                        {delivery.missingFields.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          {selectedId !== null ? (
            <Button variant="outline" size="sm" onClick={() => setSelectedId(null)}>
              Back
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={deliveriesQuery.isPending}
              onClick={deliveriesQuery.refresh}
            >
              Refresh
            </Button>
          )}
          <DialogClose render={<Button size="sm" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeliveryBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{title}</Label>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all">
        {children}
      </pre>
    </div>
  );
}

function WebhookEndpointField({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
}) {
  const canRotate = useAtomValue(
    serverEnvironment.rotateScheduledTaskWebhookToken.permissionAtom(environmentId),
  );
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "webhook URL" });
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
  });
  const [rotating, setRotating] = useState(false);
  const endpoint = task?.webhook;
  if (!task || !endpoint) {
    return <p className="text-sm text-muted-foreground">The URL appears after you save.</p>;
  }
  const { address: url, copyable, note } = webhookAddress(endpoint, httpBaseUrl);
  const rotateUrl = async () => {
    const confirmed =
      (await requestConfirmDialog("Rotate this webhook URL?\nThe current URL stops working.", {
        variant: "destructive",
      })) ?? window.confirm("Rotate this webhook URL? The current URL stops working.");
    if (!confirmed) return;
    setRotating(true);
    const result = await rotate({ environmentId, input: { id: task.id } });
    setRotating(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not rotate webhook URL",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          readOnly
          aria-label="Webhook URL"
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={!copyable}
          onClick={() => copyToClipboard(url, undefined)}
        >
          <CopyIcon />
          {isCopied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={rotating || !canRotate}
          onClick={() => void rotateUrl()}
        >
          Rotate
        </Button>
      </div>
      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {endpoint.url !== null ? <WebhookDeliveryMode environmentId={environmentId} /> : null}
    </div>
  );
}

function WebhookDeliveryMode({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const cloudLink = usePrimaryCloudLinkState();
  if (cloudLink.target?.environmentId !== environmentId || cloudLink.data === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {cloudLink.data.holdWebhooksWhileOffline
        ? "Held for up to 24 hours while this environment is offline. "
        : "Forwarded live. Requests fail while this environment is offline. "}
      <Link to="/settings/access" className="underline underline-offset-2">
        Change in Sharing & access
      </Link>
    </p>
  );
}

/**
 * Creates a task, or edits `task`. The form owns its draft from mount, so remount it (by key)
 * to discard edits or switch tasks.
 */
export function ScheduledTaskEditorForm({
  initialEnvironmentId,
  task,
  onSaved,
  onCancel,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly onSaved: (environmentId: EnvironmentId, task: ScheduledTask) => void;
  readonly onCancel: () => void;
}) {
  const connectedEnvironments = useEnvironments().environments.filter(isConnectedWithConfig);
  const [saving, setSaving] = useState(false);
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = useEnvironment(environmentId);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  // Servers without bots fail this query; the form then only offers a new thread.
  const botsQuery = useEnvironmentQuery(
    connected ? botsEnvironment.list({ environmentId, input: {} }) : null,
  );
  const bots = botsQuery.data ?? [];
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const [draft, setDraft] = useState<DraftState>(() =>
    task ? taskToDraft(task) : { ...EMPTY_DRAFT, projectId: projects[0]?.id ?? "" },
  );
  const submissionPending = useRef(false);
  const editingTaskMissing =
    draft.editingId !== null &&
    tasksQuery.data !== null &&
    !tasksQuery.data.tasks.some((entry) => entry.id === draft.editingId);
  const liveTask = tasksQuery.data
    ? (tasksQuery.data.tasks.find((entry) => entry.id === draft.editingId) ?? null)
    : task;
  const runsAsBot = draft.botId !== "";
  const runsAs = bots.find((bot) => bot.id === draft.botId) ?? null;
  const selectedProjectId = draft.projectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const instanceEntries = providerInstanceEntriesFor(
    providers,
    settings,
    selectedProject?.id ?? null,
  );

  const firstInstance = instanceEntries[0];
  const draftSelection = draft.modelKey ? splitModelKey(draft.modelKey) : null;
  const activeSelection =
    draftSelection &&
    instanceEntries.some((entry) => entry.instanceId === draftSelection.instanceId && entry.enabled)
      ? draftSelection
      : scheduledTaskDefaultModel(settings, selectedProject ?? null, instanceEntries);
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const submit = async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving ||
      editingTaskMissing ||
      !connected ||
      tasksQuery.data === null
    )
      return;
    // A bot task runs on the bot's model; the stored one only seeds a later switch to a thread.
    const selection = activeSelection ?? (runsAsBot ? (liveTask?.modelSelection ?? null) : null);
    if (
      !draft.title.trim() ||
      !draft.prompt.trim() ||
      (!runsAsBot && !projects.some((project) => project.id === selectedProjectId)) ||
      selection === null
    ) {
      reportFailure(
        "Scheduled task is incomplete",
        runsAsBot ? "Add a title and prompt." : "Add a title, prompt, project, and model.",
      );
      return;
    }
    const parsedFilters = parseWebhookFilterDrafts(draft.filters);
    if (draft.scheduleMode === "webhook" && "error" in parsedFilters) {
      reportFailure("Invalid filter", parsedFilters.error);
      return;
    }
    const schedule = scheduleFromDraft(draft);
    if (schedule === null) {
      for (const error of webhookDraftErrors(draft)) reportFailure(error.title, error.description);
      return;
    }
    if (
      schedule.type === "webhook" &&
      schedule.signature &&
      (!schedule.signature.header ||
        (!schedule.signature.secret &&
          !(liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret)))
    ) {
      reportFailure("Signing secret is required", "Enter the signature header and secret.");
      return;
    }
    if (
      schedule.type === "interval" &&
      (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS)
    ) {
      reportFailure("Invalid interval", "Enter an interval of at least one minute.");
      return;
    }
    if (
      !runsAsBot &&
      draft.workspaceMode === "existing_worktree" &&
      !draft.existingWorktreePath.trim()
    ) {
      reportFailure("Checkout path is required", "Enter the path of the checkout to run in.");
      return;
    }
    const modelSelection =
      draft.baseModelSelection !== null &&
      draft.baseModelSelection.instanceId === selection.instanceId &&
      draft.baseModelSelection.model === selection.model
        ? draft.baseModelSelection
        : selection;
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : {
              type: "worktree",
              baseRef: draft.baseRef.trim() || "main",
              startFromOrigin: draft.startFromOrigin,
            };
    const input: ScheduledTaskUpsertInput = {
      ...(draft.editingId ? { id: draft.editingId as ScheduledTaskId, requireExisting: true } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      // Pause and Resume live in the header, so an edit keeps whatever they set since.
      enabled: draft.editingId ? (liveTask?.enabled ?? draft.enabled) : draft.enabled,
      schedule,
      ...runTargetFromDraft(draft, {
        projectId: selectedProjectId as ProjectId,
        threadId: draft.threadId ? (draft.threadId as ThreadId) : null,
        workspaceStrategy,
      }),
      modelSelection,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
      creationSource: "web",
    };
    // Lock before React renders, and keep successful creates locked until the form closes.
    submissionPending.current = true;
    setSaving(true);
    const result = await upsertTask({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not save scheduled task", squashAtomCommandFailure(result));
      }
      return;
    }
    // An edit stays on screen, so it can be saved again.
    if (draft.editingId) submissionPending.current = false;
    onSaved(environmentId, result.value.task);
  };

  return (
    <div className="space-y-5">
      {/* Fieldsets default to min-width: min-content, which lets one wide control widen the form past its column. */}
      <fieldset disabled={saving} className="min-w-0 space-y-5">
        {!connected ? (
          <p className="text-sm text-destructive">Reconnect this environment before saving.</p>
        ) : null}
        <Field label="Runs on" htmlFor="scheduled-task-environment">
          <Select
            value={environmentId}
            disabled={task !== null || saving}
            onValueChange={(id) => {
              const next = connectedEnvironments.find((entry) => entry.environmentId === id);
              if (!next) return;
              setEnvironmentId(next.environmentId);
              setDraft((current) => ({
                ...current,
                botId: "",
                projectId: "",
                modelKey: "",
                baseModelSelection: null,
                baseRef: "main",
                startFromOrigin: true,
                existingWorktreePath: "",
              }));
            }}
          >
            <SelectTrigger id="scheduled-task-environment" size="sm">
              <SelectValue>
                <span className="flex items-center gap-2">
                  <EnvironmentMachineIcon
                    kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                    className="size-4"
                  />
                  {environment?.label ?? "Unavailable environment"}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {connectedEnvironments.map((entry) => {
                const { secondary } = settingsScopeEnvironmentLabels(entry, connectedEnvironments);
                return (
                  <SelectItem
                    key={entry.environmentId}
                    value={entry.environmentId}
                    label={entry.label}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <EnvironmentMachineIcon
                        kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                        className="size-4"
                      />
                      <span className="min-w-0">
                        <span className="block truncate">{entry.label}</span>
                        {secondary ? (
                          <span className="block max-w-72 truncate text-xs text-muted-foreground">
                            {secondary}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectPopup>
          </Select>
        </Field>
        {bots.length > 0 || runsAsBot ? (
          <Field label="Runs as" htmlFor="scheduled-task-runs-as">
            <Select
              value={draft.botId || NEW_THREAD_RUN}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  botId: value === NEW_THREAD_RUN || value === null ? "" : value,
                }))
              }
            >
              <SelectTrigger id="scheduled-task-runs-as" size="sm">
                <SelectValue>
                  {() =>
                    runsAsBot && runsAs === null ? (
                      botsQuery.data ? (
                        "Unavailable bot"
                      ) : (
                        "Loading…"
                      )
                    ) : (
                      <RunsAsOption bot={runsAs} />
                    )
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={NEW_THREAD_RUN}>
                  <RunsAsOption bot={null} />
                </SelectItem>
                {bots.map((bot) => (
                  <SelectItem key={bot.id} value={bot.id} label={bot.name}>
                    <RunsAsOption bot={bot} />
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {runsAsBot ? (
              <p className="text-xs text-muted-foreground">
                Runs in {runsAs?.name ?? "the bot"}'s headquarters with its model, tools and
                instructions.
              </p>
            ) : null}
          </Field>
        ) : null}
        {tasksQuery.error ? (
          <p className="text-sm text-destructive" role="status">
            {tasksQuery.error}
          </p>
        ) : null}
        {editingTaskMissing ? (
          <p className="text-xs text-destructive" role="status">
            This scheduled task no longer exists.
          </p>
        ) : null}
        <Field label="Name" htmlFor="scheduled-task-title">
          <Input
            id="scheduled-task-title"
            placeholder="e.g. Check for Sentry issues"
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          />
        </Field>

        {runsAsBot ? null : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project" htmlFor="scheduled-task-project">
              <Select
                value={selectedProjectId}
                onValueChange={(projectId) =>
                  setDraft((current) => ({ ...current, projectId: projectId ?? "" }))
                }
              >
                <SelectTrigger size="sm" id="scheduled-task-project">
                  <SelectValue placeholder="Select a project">{selectedProject?.title}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id} label={project.title}>
                      <span className="block truncate">{project.title}</span>
                      {allProjects.some(
                        (other) =>
                          other.title === project.title &&
                          (other.environmentId !== project.environmentId ||
                            other.id !== project.id),
                      ) ? (
                        <span className="block max-w-72 truncate text-xs text-muted-foreground">
                          {project.workspaceRoot}
                        </span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>

            <Field label="Workspace" htmlFor="scheduled-task-workspace">
              <Select
                value={draft.workspaceMode}
                onValueChange={(value) =>
                  setDraft((current) => ({ ...current, workspaceMode: value as WorkspaceMode }))
                }
              >
                <SelectTrigger size="sm" id="scheduled-task-workspace">
                  <SelectValue>{WORKSPACE_MODE_LABELS[draft.workspaceMode]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="worktree">Create a new worktree</SelectItem>
                  <SelectItem value="root">Use the project checkout</SelectItem>
                  <SelectItem value="existing_worktree">Use a specific checkout</SelectItem>
                </SelectPopup>
              </Select>
            </Field>
          </div>
        )}

        {!runsAsBot && draft.workspaceMode === "worktree" ? (
          <Field label="Base branch" htmlFor="scheduled-task-base-ref">
            <WorktreeBaseBranchPicker
              key={`${environmentId}:${selectedProjectId}`}
              id="scheduled-task-base-ref"
              environmentId={environmentId}
              cwd={selectedProject?.workspaceRoot ?? null}
              value={draft.baseRef}
              onValueChange={(baseRef) => setDraft((current) => ({ ...current, baseRef }))}
              startFromOrigin={draft.startFromOrigin}
              onStartFromOriginChange={(startFromOrigin) =>
                setDraft((current) => ({ ...current, startFromOrigin }))
              }
              disabled={saving || !connected}
            />
          </Field>
        ) : null}
        {!runsAsBot && draft.workspaceMode === "existing_worktree" ? (
          <Field label="Checkout path" htmlFor="scheduled-task-checkout">
            <Input
              id="scheduled-task-checkout"
              value={draft.existingWorktreePath}
              placeholder="/path/to/checkout"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  existingWorktreePath: event.target.value,
                }))
              }
            />
          </Field>
        ) : null}

        <Field label="Prompt" htmlFor="scheduled-task-prompt">
          <InstructionsEditor
            id="scheduled-task-prompt"
            label="Prompt"
            size="sm"
            disabled={saving}
            placeholder="What should the agent do each time this runs?"
            value={draft.prompt}
            onChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
          />
        </Field>

        {runsAsBot ? null : (
          <Field label="Model">
            <div>
              <ProviderModelPicker
                environmentId={environmentId}
                disabled={saving || !connected}
                activeInstanceId={activeInstanceId}
                model={activeModel}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                isComposerOwned={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onInstanceModelChange={(instanceId, model) =>
                  setDraft((current) => ({ ...current, modelKey: `${instanceId}:${model}` }))
                }
              />
            </div>
          </Field>
        )}

        <div className="space-y-3">
          {task?.schedule.type === "interval" &&
          task.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS ? (
            <p className="text-sm text-muted-foreground" role="status">
              This task uses a legacy interval below one minute. Saving updates it to at least one
              minute.
            </p>
          ) : null}
          {/* Wraps the toggle below the label when both don't fit, as on phones. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label>Schedule</Label>
            <ToggleGroup
              aria-label="Schedule type"
              value={[draft.scheduleMode]}
              onValueChange={(values) => {
                const mode = values[0] as ScheduleMode | undefined;
                if (mode === "fixed" || mode === "interval" || mode === "webhook")
                  setDraft((current) => ({
                    ...current,
                    scheduleMode: mode,
                    prompt:
                      mode === "webhook" && !current.prompt.trim()
                        ? DEFAULT_WEBHOOK_PROMPT
                        : current.prompt,
                  }));
              }}
            >
              <Toggle value="fixed">At a time</Toggle>
              <Toggle value="interval">Every interval</Toggle>
              <Toggle value="webhook">On webhook</Toggle>
            </ToggleGroup>
          </div>

          {draft.scheduleMode === "webhook" ? (
            <div className="space-y-4">
              <WebhookEndpointField environmentId={environmentId} task={liveTask} />
              <p className="text-xs text-muted-foreground">
                {
                  "Each request runs the prompt. Use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} in the prompt; only what it names reaches the agent."
                }
              </p>
              <DisclosureSection
                title="Filters"
                summary={
                  [
                    draft.filters.length > 0
                      ? `${draft.filters.length} ${draft.filters.length === 1 ? "filter" : "filters"}`
                      : null,
                    draft.maxDeliveryAgeMinutes.trim() ? "skips old requests" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || null
                }
                defaultOpen={draft.filters.length > 0 || draft.maxDeliveryAgeMinutes.trim() !== ""}
              >
                <Field
                  label="Skip requests older than"
                  hint="minutes, optional"
                  htmlFor="scheduled-task-max-age"
                >
                  <Input
                    id="scheduled-task-max-age"
                    type="number"
                    nativeInput
                    min={1}
                    max={MAX_WEBHOOK_DELIVERY_AGE_MINUTES}
                    placeholder="Run every request"
                    value={draft.maxDeliveryAgeMinutes}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        maxDeliveryAgeMinutes: event.target.value,
                      }))
                    }
                  />
                </Field>
                <WebhookFiltersField
                  filters={draft.filters}
                  onChange={(filters) => setDraft((current) => ({ ...current, filters }))}
                />
              </DisclosureSection>
              <DisclosureSection
                title="Deduplication"
                summary={draft.replayKey.trim() || draft.coalesceKey.trim() ? "On" : null}
                defaultOpen={draft.replayKey.trim() !== "" || draft.coalesceKey.trim() !== ""}
              >
                <Field
                  label="Replay key"
                  hint="template, optional"
                  htmlFor="scheduled-task-replay-key"
                >
                  <Input
                    id="scheduled-task-replay-key"
                    placeholder="{{headers.delivery-id}}"
                    value={draft.replayKey}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, replayKey: event.target.value }))
                    }
                  />
                </Field>
                <Field
                  label="Coalesce key"
                  hint="template, optional"
                  htmlFor="scheduled-task-coalesce-key"
                >
                  <Input
                    id="scheduled-task-coalesce-key"
                    placeholder="{{body.id}}"
                    value={draft.coalesceKey}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, coalesceKey: event.target.value }))
                    }
                  />
                </Field>
                <Field
                  label="Coalesce window"
                  hint="seconds, 10–3600"
                  htmlFor="scheduled-task-coalesce-window"
                >
                  <Input
                    id="scheduled-task-coalesce-window"
                    type="number"
                    nativeInput
                    min={10}
                    max={3600}
                    placeholder="120"
                    value={draft.coalesceWindowSeconds}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        coalesceWindowSeconds: event.target.value,
                      }))
                    }
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  Replay keys suppress repeat deliveries for 7 days. Coalescing runs the latest
                  payload once when the window from the first delivery closes. Empty keys run
                  normally.
                </p>
              </DisclosureSection>
              <DisclosureSection
                title="Signature"
                summary={draft.signatureEnabled ? "On" : null}
                defaultOpen={draft.signatureEnabled}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor="scheduled-task-signature">Require signature</Label>
                    <p className="text-sm text-muted-foreground">
                      Reject requests without a valid HMAC-SHA256 signature of the body.
                    </p>
                  </div>
                  <Switch
                    id="scheduled-task-signature"
                    checked={draft.signatureEnabled}
                    onCheckedChange={(signatureEnabled) =>
                      setDraft((current) => ({ ...current, signatureEnabled }))
                    }
                  />
                </div>
                {draft.signatureEnabled ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Header" htmlFor="scheduled-task-signature-header">
                      <Input
                        id="scheduled-task-signature-header"
                        value={draft.signatureHeader}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            signatureHeader: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field label="Prefix" htmlFor="scheduled-task-signature-prefix">
                      <Input
                        id="scheduled-task-signature-prefix"
                        value={draft.signaturePrefix}
                        placeholder="None"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            signaturePrefix: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field label="Encoding" htmlFor="scheduled-task-signature-encoding">
                      <Select
                        value={draft.signatureEncoding}
                        onValueChange={(value) =>
                          setDraft((current) => ({
                            ...current,
                            signatureEncoding: value === "base64" ? "base64" : "hex",
                          }))
                        }
                      >
                        <SelectTrigger size="sm" id="scheduled-task-signature-encoding">
                          <SelectValue>{draft.signatureEncoding}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="hex">hex</SelectItem>
                          <SelectItem value="base64">base64</SelectItem>
                        </SelectPopup>
                      </Select>
                    </Field>
                    <Field label="Secret" htmlFor="scheduled-task-signature-secret">
                      <Input
                        id="scheduled-task-signature-secret"
                        type="password"
                        autoComplete="off"
                        value={draft.signatureSecret}
                        placeholder={
                          liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret
                            ? "Unchanged"
                            : "Shared secret"
                        }
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            signatureSecret: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  </div>
                ) : null}
              </DisclosureSection>
            </div>
          ) : draft.scheduleMode === "fixed" ? (
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <Label htmlFor="scheduled-task-time">Run at</Label>
                <Input
                  type="time"
                  id="scheduled-task-time"
                  nativeInput
                  className="w-32"
                  value={draft.timeOfDay}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                  }
                />
                <span className="text-xs text-muted-foreground">on</span>
              </div>
              <ToggleGroup
                multiple
                variant="outline"
                size="sm"
                aria-label="Days to run"
                value={[...draft.weekdays].map(String)}
                onValueChange={(values) => {
                  if (values.length === 0) return;
                  setDraft((current) => ({
                    ...current,
                    weekdays: new Set(values.map(Number)),
                  }));
                }}
              >
                {WEEKDAY_ORDER.map((day) => (
                  <Toggle key={day} value={String(day)} aria-label={WEEKDAY_LABELS[day]}>
                    {WEEKDAY_SHORT[day]}
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Label htmlFor="scheduled-task-interval">Run every</Label>
              <Input
                type="number"
                id="scheduled-task-interval"
                nativeInput
                min={1}
                step="any"
                className="w-24"
                value={draft.intervalMinutes}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))
                }
              />
              <span className="text-xs text-muted-foreground">minutes</span>
            </div>
          )}
        </div>

        {draft.editingId ? null : (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="scheduled-task-enabled">Start enabled</Label>
              <p id="scheduled-task-enabled-description" className="text-sm text-muted-foreground">
                Paused tasks stay saved but do not run.
              </p>
            </div>
            <Switch
              id="scheduled-task-enabled"
              aria-describedby="scheduled-task-enabled-description"
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            />
          </div>
        )}
      </fieldset>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>
          {draft.editingId ? "Discard changes" : "Cancel"}
        </Button>
        <Button
          size="sm"
          disabled={!canOperate || saving || editingTaskMissing || !connected || !tasksQuery.data}
          onClick={() => void submit()}
        >
          {draft.editingId ? "Save task" : "Create task"}
        </Button>
      </div>
    </div>
  );
}
