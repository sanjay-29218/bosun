import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentFeatureCard } from "@t3tools/client-runtime/state/crew-board";
import {
  featureForIssue,
  featuresByIssue,
  ticketIssue,
  type EnvironmentIssue,
} from "@t3tools/client-runtime/state/issue-board";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  ISSUE_IMAGE_MAX_BYTES,
  IssueChangedError,
  ticketRef,
  type EnvironmentId,
  type IssueDetail,
  type IssueList,
  type Ticket,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  CircleDotIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  NotebookTextIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { createContext, use, useRef, useState, type ReactNode } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { featuresEnvironment } from "../../state/features";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { InstructionsEditor } from "../InstructionsEditor";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FeatureIssueIcon } from "../crew/FeatureIssueIcon";
import { featureStatus } from "./FeatureCard";
import { readFileAsDataUrl } from "../../lib/imageCompression";
import { cn } from "../../lib/utils";
import {
  MilestoneChip,
  ParentChip,
  SubIssuesSection,
  parentChoices,
  useShowMilestoneOnBoard,
  type StructureChange,
} from "./IssueStructureDetail";
import {
  closeTodo,
  openNewTodoDialog,
  openTodo,
  todoDetailAtom,
  type TodoOwner,
  type TodoTarget,
} from "./todoDialogs";
import { createSerialSaves } from "./descriptionSaves.logic";
import { CloseTodoButton, failureText, ReopenTodoButton } from "./todoState";

/**
 * Starts a feature in a new thread's composer, in a new worktree: the first message is the
 * brief, which goes to the feature's lead. A todo's brief names it, by
 * the issue's URL or a `Ticket T-<number>` line, so creating the feature links it.
 */
export function useStartFeatureDraft() {
  const newThread = useNewThreadHandler();
  return (
    project: TodoOwner,
    todo?: { readonly issue: EnvironmentIssue; readonly description?: string | undefined },
  ) => {
    closeTodo();
    const brief = !todo
      ? ""
      : todo.issue.ticketId
        ? [todo.issue.title, todo.description?.trim(), `Ticket ${ticketRef(todo.issue)}`]
            .filter(Boolean)
            .join("\n\n")
        : `${todo.issue.title}\n\n${todo.issue.url}`;
    void newThread(scopeProjectRef(project.environmentId, project.projectId), {
      envMode: "worktree",
      feature: true,
      ...(brief ? { prompt: brief } : {}),
    });
  };
}

const todoProject = (issue: EnvironmentIssue): TodoOwner => ({
  environmentId: issue.environmentId,
  projectId: issue.projectId,
});

const confirm = async (message: string) => {
  try {
    return (await readLocalApi()?.dialogs.confirm(message, { variant: "destructive" })) ?? false;
  } catch {
    return false;
  }
};

export function TodoDetailHost() {
  const target = useAtomValue(todoDetailAtom);
  // The last todo stays rendered while the sheet closes, so its edits still save on blur.
  const [shown, setShown] = useState(target);
  if (target !== null && target !== shown) setShown(target);
  const key = shown
    ? `${shown.environmentId}:${shown.projectId}:${shown.ticketId ?? shown.number}`
    : "";
  return (
    <Sheet open={target !== null} onOpenChange={(open) => (open ? undefined : closeTodo())}>
      <SheetPopup side="right" className="w-[min(94vw,40rem)] max-w-[40rem]">
        {shown ? <TodoDetail key={key} target={shown} /> : null}
      </SheetPopup>
    </Sheet>
  );
}

/**
 * Where a todo shows: the board's sheet, or a thread's right panel. The panel has no sheet to
 * title or close, and opens the issue a ticket moves to in itself.
 */
const TodoDetailPlace = createContext<{
  readonly inPanel: boolean;
  readonly open: (target: TodoTarget) => void;
}>({ inPanel: false, open: openTodo });

/** A todo in a thread's right panel, as the board's sheet shows it. */
export function TodoDetailPanel(props: {
  readonly target: TodoTarget;
  readonly onOpen: (target: TodoTarget) => void;
}) {
  const { target } = props;
  return (
    <TodoDetailPlace value={{ inPanel: true, open: props.onOpen }}>
      <div className="flex min-h-0 flex-1 flex-col">
        <TodoDetail
          key={`${target.environmentId}:${target.projectId}:${target.ticketId ?? target.number}`}
          target={target}
        />
      </div>
    </TodoDetailPlace>
  );
}

function DetailTitle(props: { readonly className?: string; readonly children: ReactNode }) {
  return use(TodoDetailPlace).inPanel ? (
    <h2 className={cn("text-base font-semibold leading-snug", props.className)}>
      {props.children}
    </h2>
  ) : (
    <SheetTitle className={props.className}>{props.children}</SheetTitle>
  );
}

function TodoDetail({ target }: { readonly target: TodoTarget }) {
  const { environmentId, projectId } = target;
  const project =
    useProjects().find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
    ) ?? null;
  const owner = { environmentId, input: { projectId } };
  const tickets = useEnvironmentQuery(featuresEnvironment.tickets(owner));
  const issues = useEnvironmentQuery(featuresEnvironment.issues(owner));
  const board = useEnvironmentQuery(featuresEnvironment.board(owner));
  const features = featuresByIssue(
    (board.data ?? []).map((card): EnvironmentFeatureCard => ({ ...card, environmentId })),
  );

  if (target.ticketId !== undefined) {
    const ticket = tickets.data?.find((candidate) => candidate.id === target.ticketId) ?? null;
    if (!ticket) {
      return tickets.data === null && !tickets.error ? (
        <DetailSkeleton />
      ) : (
        <Gone
          text={tickets.error ?? "This ticket was moved or deleted."}
          failed={tickets.error != null}
        />
      );
    }
    const row = ticketIssue(ticket, environmentId);
    return (
      <TicketDetail
        environmentId={environmentId}
        ticket={ticket}
        project={project}
        feature={featureForIssue(features, row)}
        canFileIssues={issues.data?.unavailable === null}
      />
    );
  }
  return (
    <GitHubIssueDetail
      owner={{ environmentId, projectId }}
      number={target.number}
      {...(target.url === undefined ? {} : { url: target.url })}
      project={project}
      issueList={issues.data ?? null}
      featureFor={(row) => featureForIssue(features, row)}
    />
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-6">
      <DetailTitle className="sr-only">Loading</DetailTitle>
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/** A todo that is gone, or one that couldn't be read, which is a different problem. */
function Gone(props: {
  readonly text: string;
  readonly failed?: boolean;
  readonly title?: string;
  /** Where it lives on its host, offered when the sheet can't show it. */
  readonly url?: string | undefined;
}) {
  const { url } = props;
  return (
    <div className="flex flex-col items-start gap-3 p-6">
      <div>
        <DetailTitle>
          {props.title ?? (props.failed ? "Couldn't load this todo" : "Todo not found")}
        </DetailTitle>
        <p className="mt-2 text-sm text-muted-foreground">{props.text}</p>
      </div>
      {url ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void readLocalApi()?.shell.openExternal(url)}
        >
          <ExternalLinkIcon aria-hidden />
          Open on GitHub
        </Button>
      ) : null}
    </div>
  );
}

/** Whether two issue links name the same issue, ignoring case and a trailing slash. */
const sameUrl = (a: string, b: string) =>
  a.trim().replace(/\/+$/u, "").toLowerCase() === b.trim().replace(/\/+$/u, "").toLowerCase();

/** One column: a header with the todo's place and actions, then the todo as a document. */
function DetailLayout(props: {
  readonly crumb: ReactNode;
  readonly actions: ReactNode;
  readonly children: ReactNode;
}) {
  const { inPanel } = use(TodoDetailPlace);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The end padding leaves room for the sheet's close button. */}
      <header
        className={cn(
          "flex h-12 shrink-0 items-center gap-1.5 border-b border-border ps-5 text-xs text-muted-foreground",
          inPanel ? "pe-3" : "pe-12",
        )}
      >
        {props.crumb}
        <div className="ms-auto flex shrink-0 items-center gap-1">{props.actions}</div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pt-5 pb-8 *:shrink-0">
        {props.children}
      </div>
    </div>
  );
}

const chipClassName =
  "inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border/70 px-2 text-xs text-muted-foreground";

function Chip(props: { readonly children: ReactNode }) {
  return <span className={chipClassName}>{props.children}</span>;
}

function MoreActions(props: { readonly children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="icon-xs" variant="ghost-muted" aria-label="More actions">
            <EllipsisIcon aria-hidden />
          </Button>
        }
      />
      <MenuPopup align="end">{props.children}</MenuPopup>
    </Menu>
  );
}

/** The feature working on a todo, as its live status; opening it shows the feature's lead. */
function FeatureChip(props: { readonly feature: EnvironmentFeatureCard | null }) {
  const navigate = useNavigate();
  const shells = useQuietThreadShells();
  const { feature } = props;
  if (!feature) return <Chip>No feature yet</Chip>;
  const { status } = featureStatus(
    feature,
    shells.filter(
      (shell) =>
        shell.environmentId === feature.environmentId && shell.feature?.id === feature.featureId,
    ),
  );
  const StatusIcon = status.icon;
  const threadId = feature.leadThreadId;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={!threadId}
            onClick={() => {
              if (!threadId) return;
              closeTodo();
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: feature.environmentId, threadId },
              });
            }}
            className={cn(
              chipClassName,
              "cursor-pointer hover:border-border hover:text-foreground",
            )}
          />
        }
      >
        <StatusIcon aria-hidden className={cn("size-3.5 shrink-0", status.className)} />
        <span className="font-medium text-foreground">{status.label}</span>
        <span className="truncate">{feature.title}</span>
      </TooltipTrigger>
      <TooltipPopup>Open the feature</TooltipPopup>
    </Tooltip>
  );
}

/** Offered on the board; in a thread's panel the todo is already what that thread works on. */
function StartFeatureButton(props: { readonly onStart: () => void }) {
  if (use(TodoDetailPlace).inPanel) return null;
  return (
    <Button size="xs" onClick={props.onStart}>
      <PlayIcon aria-hidden />
      Start feature
    </Button>
  );
}

const DESCRIPTION_SAVE_DELAY_MS = 800;

const TICKET_STATUSES = {
  open: "Open",
  completed: "Done",
  not_planned: "Cancelled",
} as const;
type TicketStatus = keyof typeof TICKET_STATUSES;

const ticketStatus = (ticket: Ticket): TicketStatus =>
  ticket.state === "open" ? "open" : (ticket.closedReason ?? "completed");

function TicketDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly ticket: Ticket;
  readonly project: EnvironmentProject | null;
  readonly feature: EnvironmentFeatureCard | null;
  readonly canFileIssues: boolean;
}) {
  const { ticket, feature } = props;
  const place = use(TodoDetailPlace);
  const canEdit = useAtomValue(
    featuresEnvironment.updateTicket.permissionAtom(props.environmentId),
  );
  const [title, setTitle] = useState(ticket.title);
  const [busy, setBusy] = useState<"save" | "move" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const row = ticketIssue(ticket, props.environmentId);
  const target = { environmentId: props.environmentId };
  const startFeature = useStartFeatureDraft();

  const update = async (patch: {
    readonly title?: string;
    readonly description?: string;
    readonly state?: "open" | "closed";
    readonly closedReason?: "completed" | "not_planned";
  }): Promise<boolean> => {
    setBusy("save");
    setError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      featuresEnvironment.updateTicket,
      { ...target, input: { projectId: ticket.projectId, ticketId: ticket.id, ...patch } },
      { reportFailure: false },
    );
    setBusy(null);
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      setError(failureText(result, "The ticket could not be saved."));
    }
    return false;
  };

  const saveTitle = () => {
    const trimmed = title.trim();
    if (!trimmed) setTitle(ticket.title);
    else if (trimmed !== ticket.title) void update({ title: trimmed });
  };

  const move = async () => {
    if (!(await confirm(`File ${ticketRef(ticket)} as a GitHub issue and delete the ticket?`)))
      return;
    setBusy("move");
    setError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      featuresEnvironment.moveTicketToIssue,
      { ...target, input: { projectId: ticket.projectId, ticketId: ticket.id } },
      { reportFailure: false },
    );
    setBusy(null);
    if (result._tag === "Success") {
      place.open({ ...target, projectId: ticket.projectId, number: result.value.number });
    } else if (!isAtomCommandInterrupted(result)) {
      setError(failureText(result, "The ticket could not be moved."));
    }
  };

  const remove = async () => {
    if (!(await confirm(`Delete ${ticketRef(ticket)}? Features working on it are unlinked.`)))
      return;
    setBusy("delete");
    setError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      featuresEnvironment.deleteTicket,
      { ...target, input: { projectId: ticket.projectId, ticketId: ticket.id } },
      { reportFailure: false },
    );
    setBusy(null);
    if (result._tag === "Success") closeTodo();
    else if (!isAtomCommandInterrupted(result)) {
      setError(failureText(result, "The ticket could not be deleted."));
    }
  };

  const markdown = (text: string) => (
    <ChatMarkdown
      text={text}
      cwd={props.project?.workspaceRoot}
      environmentId={props.environmentId}
    />
  );

  const status = ticketStatus(ticket);
  return (
    <DetailLayout
      crumb={
        <>
          <span className="truncate">{props.project?.title}</span>
          <span aria-hidden>›</span>
          <NotebookTextIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="shrink-0 font-mono">{ticketRef(ticket)}</span>
        </>
      }
      actions={
        <>
          {ticket.state === "open" && !feature ? (
            <StartFeatureButton
              onStart={() =>
                startFeature(todoProject(row), { issue: row, description: ticket.description })
              }
            />
          ) : null}
          <MoreActions>
            {props.canFileIssues ? (
              <MenuItem disabled={busy !== null} onClick={() => void move()}>
                <CircleDotIcon aria-hidden />
                Move to GitHub issue
              </MenuItem>
            ) : null}
            <MenuItem variant="destructive" disabled={busy !== null} onClick={() => void remove()}>
              <Trash2Icon aria-hidden />
              Delete ticket
            </MenuItem>
          </MoreActions>
        </>
      }
    >
      <DetailTitle className="sr-only">{ticket.title}</DetailTitle>
      <textarea
        aria-label="Title"
        rows={1}
        value={title}
        readOnly={!canEdit}
        onChange={(event) => setTitle(event.target.value.replace(/\n/g, " "))}
        onBlur={saveTitle}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          event.currentTarget.blur();
        }}
        className="field-sizing-content w-full resize-none bg-transparent text-xl font-semibold leading-snug outline-none placeholder:text-muted-foreground"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <Menu>
          <MenuTrigger
            disabled={!canEdit}
            render={
              <button
                type="button"
                aria-label="Status"
                className={cn(
                  chipClassName,
                  "cursor-pointer hover:border-border hover:text-foreground",
                )}
              />
            }
          >
            <span className="font-medium text-foreground">{TICKET_STATUSES[status]}</span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuRadioGroup
              value={status}
              onValueChange={(value) => {
                if (value === status) return;
                void update(
                  value === "open"
                    ? { state: "open" }
                    : { state: "closed", closedReason: value as Exclude<TicketStatus, "open"> },
                );
              }}
            >
              {Object.entries(TICKET_STATUSES).map(([value, label]) => (
                <MenuRadioItem key={value} value={value}>
                  {label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
        <FeatureChip feature={feature} />
        <Chip>Created {formatRelativeTimeLabel(ticket.createdAt)}</Chip>
      </div>
      <DescriptionBody
        text={ticket.description}
        version={ticket.updatedAt}
        save={(description) => update({ description })}
        uploadImage={(file) =>
          uploadTodoImage("ticket", { ...target, projectId: ticket.projectId }, file)
        }
        markdown={markdown}
        editable={canEdit}
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <p className="mt-auto border-t border-border pt-3 text-xs text-muted-foreground">
          {busy === "save" ? "Saving…" : `Updated ${formatRelativeTimeLabel(ticket.updatedAt)}`}
        </p>
      )}
    </DetailLayout>
  );
}

const ISSUE_CLOSED_LABELS: Record<NonNullable<IssueDetail["closedReason"]>, string> = {
  completed: "Closed as completed",
  not_planned: "Closed as not planned",
  duplicate: "Closed as duplicate",
};

type IssueEdit = { readonly title: string } | { readonly body: string };
type SaveIssueEdit = (edit: IssueEdit) => Promise<boolean>;
const isIssueChanged = Schema.is(IssueChangedError);

/**
 * Saves edits to one issue, each expecting GitHub's copy as this sheet last saw it: its read, or
 * its own last save when the refreshed read hasn't landed yet. When someone changed it on GitHub
 * meanwhile, one toast offers to save anyway.
 */
/**
 * Stores a pasted image: an issue's on its GitHub repository, a ticket's on its environment. Null,
 * after saying why, when it can't.
 */
async function uploadTodoImage(
  kind: "issue" | "ticket",
  owner: Pick<TodoOwner, "environmentId" | "projectId">,
  file: File,
): Promise<string | null> {
  if (file.size > ISSUE_IMAGE_MAX_BYTES) {
    toastManager.add({ type: "error", title: "That image is over 10 MB", description: file.name });
    return null;
  }
  const upload = {
    environmentId: owner.environmentId,
    input: {
      projectId: owner.projectId,
      fileName: file.name || "image.png",
      dataUrl: await readFileAsDataUrl(file),
    },
  };
  const result =
    kind === "issue"
      ? await runAtomCommand(appAtomRegistry, featuresEnvironment.uploadIssueImage, upload, {
          reportFailure: false,
        })
      : await runAtomCommand(appAtomRegistry, featuresEnvironment.uploadTicketImage, upload, {
          reportFailure: false,
        });
  if (result._tag === "Success") return result.value.url;
  if (!isAtomCommandInterrupted(result)) {
    toastManager.add({
      type: "error",
      title: "Could not add the image",
      description: failureText(result, "Nothing changed."),
    });
  }
  return null;
}

function useIssueEditSaver(owner: TodoOwner, issue: IssueDetail | null | undefined): SaveIssueEdit {
  const savedAt = useRef<string | null>(null);
  const conflictToast = useRef<string | null>(null);
  const save = async (edit: IssueEdit, overwrite = false): Promise<boolean> => {
    if (!issue) return false;
    const expected =
      savedAt.current !== null && savedAt.current > issue.updatedAt
        ? savedAt.current
        : issue.updatedAt;
    const result = await runAtomCommand(
      appAtomRegistry,
      featuresEnvironment.updateIssue,
      {
        environmentId: owner.environmentId,
        input: {
          projectId: owner.projectId,
          number: issue.number,
          ...edit,
          ...(overwrite ? {} : { expectedUpdatedAt: expected }),
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Success") {
      savedAt.current = result.value.updatedAt;
      return true;
    }
    if (isAtomCommandInterrupted(result)) return false;
    if (isIssueChanged(squashAtomCommandFailure(result))) {
      if (conflictToast.current !== null) toastManager.close(conflictToast.current);
      const id = toastManager.add({
        type: "warning",
        title: `#${issue.number} changed on GitHub since you opened it`,
        description: "Saving replaces that change. Refresh to see it first.",
        actionProps: {
          children: "Save anyway",
          onClick: () => {
            toastManager.close(id);
            void save(edit, true);
          },
        },
      });
      conflictToast.current = id;
    } else {
      toastManager.add({
        type: "error",
        title: `Could not save #${issue.number}`,
        description: failureText(result, "GitHub did not change the issue."),
      });
    }
    return false;
  };
  return save;
}

/** The title, edited in place like a ticket's: Enter or leaving the field saves it. */
function IssueTitleField(props: {
  readonly title: string;
  readonly save: SaveIssueEdit;
  readonly editable: boolean;
}) {
  const [title, setTitle] = useState(props.title);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed === props.title) return setTitle(props.title);
    setSaving(true);
    if (!(await props.save({ title: trimmed }))) setSaving(false);
  };
  return (
    <textarea
      aria-label="Title"
      rows={1}
      value={title}
      readOnly={saving || !props.editable}
      onChange={(event) => setTitle(event.target.value.replace(/\n/g, " "))}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === "Escape") setTitle(props.title);
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.currentTarget.blur();
      }}
      className={cn(
        "field-sizing-content w-full resize-none bg-transparent text-xl font-semibold leading-snug outline-none",
        saving && "text-muted-foreground",
      )}
    />
  );
}

/**
 * A todo's description as rendered Markdown, images and all. Clicking it edits the Markdown in
 * place, at the clicked spot; a pause in typing or leaving it saves.
 */
function DescriptionBody(props: {
  readonly text: string;
  /** When the todo last changed; a newer read replaces what this last saved. */
  readonly version: string;
  readonly save: (text: string) => Promise<boolean>;
  readonly uploadImage: (file: File) => Promise<string | null>;
  readonly markdown: (text: string) => ReactNode;
  /** False where this client can't change it, which leaves it read-only. */
  readonly editable: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Handlers outlive their render while an upload runs, so they read the live count.
  const uploads = useRef(0);
  const [uploading, setUploading] = useState(0);
  // Shown after a save until the refreshed read lands, so the old text doesn't flash back.
  const [saved, setSaved] = useState<{ body: string; over: string } | null>(null);
  const shown = saved !== null && saved.over === props.version ? saved.body : props.text;
  // One write at a time, so an older text can't land after a newer one.
  const [saves] = useState(() => createSerialSaves(shown));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const flush = (body: string) => {
    cancelTimer();
    const version = props.version;
    return saves.save(body, async (text) => {
      setSaving(true);
      const ok = await props.save(text);
      setSaving(false);
      if (ok) setSaved({ body: text, over: version });
      return ok;
    });
  };
  // The newest text typed, read when a save started by leaving finishes.
  const latestDraft = useRef<string | null>(null);
  const change = (body: string) => {
    latestDraft.current = body;
    setDraft(body);
    cancelTimer();
    // Saving now would store an upload's placeholder; the image's own change saves.
    timer.current = setTimeout(() => {
      if (uploads.current === 0) void flush(body);
    }, DESCRIPTION_SAVE_DELAY_MS);
  };
  const upload = (file: File) => {
    // The placeholder's own change scheduled a save just before this; it waits for the image.
    cancelTimer();
    uploads.current += 1;
    setUploading(uploads.current);
    return props.uploadImage(file).finally(() => {
      uploads.current -= 1;
      setUploading(uploads.current);
    });
  };
  // Where the click landed, so the caret goes there; the keyboard opens it at the end.
  const [openedAt, setOpenedAt] = useState<{ x: number; y: number } | true>(true);
  const startEditing = (point: { x: number; y: number } | true) => {
    saves.reset(shown);
    latestDraft.current = shown;
    setOpenedAt(point);
    setDraft(shown);
  };

  // One element in both modes: removing the focused one would make the sheet pull focus back to
  // itself, which reads as leaving the editor and closes it as soon as it opens.
  const editing = draft !== null;
  const offersEditing = !editing && props.editable;
  return (
    <div
      {...(offersEditing ? { tabIndex: 0 } : editing ? { tabIndex: -1 } : {})}
      aria-label={offersEditing ? "Description. Press Enter to edit." : undefined}
      className={cn(
        "-mx-2 mt-1 flex flex-col gap-1 rounded-md px-2 py-1 outline-none",
        offersEditing &&
          "cursor-text hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      )}
      onClick={(event) => {
        if (!offersEditing) return;
        // Links, buttons and a text selection keep their own clicks.
        if ((event.target as Element).closest("a, button, summary, input, img")) return;
        if (window.getSelection()?.toString()) return;
        startEditing({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (!offersEditing || event.key !== "Enter" || event.target !== event.currentTarget) return;
        event.preventDefault();
        startEditing(true);
      }}
      onBlur={(event) => {
        if (!editing || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        // An image still uploading lands in the editor, so it stays open until then.
        if (uploads.current > 0) return;
        // The editor can drop focus for a moment while it remounts, so it decides once focus settles.
        const wrapper = event.currentTarget;
        setTimeout(() => {
          if (wrapper.contains(document.activeElement)) return;
          // Leaving keeps the editor open when the save failed, or when typing resumed while it
          // ran, so nothing typed is lost.
          void flush(draft).then((ok) => {
            if (!ok || latestDraft.current !== draft) return;
            if (wrapper.contains(document.activeElement)) return;
            setDraft(null);
          });
        }, 0);
      }}
    >
      {editing ? (
        <>
          <InstructionsEditor
            label="Description"
            value={draft}
            onChange={change}
            placeholder="Add a description…"
            size="lg"
            variant="document"
            autoFocus={openedAt}
            onPasteImage={upload}
          />
          <p className="text-xs text-muted-foreground">
            {uploading > 0 ? "Uploading image…" : saving ? "Saving…" : "Saves as you type"}
          </p>
        </>
      ) : shown.trim() ? (
        props.markdown(shown)
      ) : (
        <p className="text-sm text-muted-foreground">Add a description…</p>
      )}
    </div>
  );
}

function GitHubIssueDetail(props: {
  readonly owner: TodoOwner;
  readonly number: number;
  /** The link it was opened from; a different issue by that number isn't shown as this one. */
  readonly url?: string;
  readonly project: EnvironmentProject | null;
  /** The repository's loaded issues and open milestones, for the structure pickers. */
  readonly issueList: IssueList | null;
  readonly featureFor: (row: EnvironmentIssue) => EnvironmentFeatureCard | null;
}) {
  const { owner } = props;
  const detail = useEnvironmentQuery(
    featuresEnvironment.issueDetail({
      environmentId: owner.environmentId,
      input: { projectId: owner.projectId, number: props.number },
    }),
  );
  const startFeature = useStartFeatureDraft();
  const issue = detail.data;
  const save = useIssueEditSaver(owner, issue);
  const canEdit = useAtomValue(featuresEnvironment.updateIssue.permissionAtom(owner.environmentId));
  const place = use(TodoDetailPlace);
  const showOnBoard = useShowMilestoneOnBoard();
  // A milestone or parent picked here shows at once, until the read after saving lands.
  const [pending, setPending] = useState<(StructureChange & { readonly over: string }) | null>(
    null,
  );
  const [structureError, setStructureError] = useState<string | null>(null);
  if (!issue) {
    return detail.error ? <Gone text={detail.error} failed url={props.url} /> : <DetailSkeleton />;
  }
  if (props.url !== undefined && !sameUrl(props.url, issue.url)) {
    return (
      <Gone
        title="In another repository"
        text={`This issue isn't in ${props.project?.title ?? "this project"}'s repository, so it opens on GitHub.`}
        url={props.url}
      />
    );
  }
  const row: EnvironmentIssue = { ...issue, ...owner, ticketId: null };
  const feature = props.featureFor(row);

  const shownChange = pending !== null && pending.over === issue.readAt ? pending : null;
  const milestone = shownChange?.milestone === undefined ? issue.milestone : shownChange.milestone;
  const parent = shownChange?.parent === undefined ? issue.parent : shownChange.parent;
  const loadedIssues = props.issueList?.issues ?? [];
  const parentTitle =
    parent === null
      ? null
      : issue.parentIssue?.number === parent
        ? issue.parentIssue.title
        : (loadedIssues.find((candidate) => candidate.number === parent)?.title ?? null);
  const choices = parentChoices(loadedIssues, issue);
  const openIssue = (number: number) => place.open({ ...owner, number });
  const refreshDetail = (number: number) =>
    appAtomRegistry.refresh(
      featuresEnvironment.issueDetail({
        environmentId: owner.environmentId,
        input: { projectId: owner.projectId, number },
      }),
    );
  const updateStructure = (number: number, change: StructureChange) =>
    runAtomCommand(
      appAtomRegistry,
      featuresEnvironment.updateIssue,
      {
        environmentId: owner.environmentId,
        input: {
          projectId: owner.projectId,
          number,
          ...(change.milestone === undefined
            ? {}
            : { milestone: change.milestone?.number ?? null }),
          ...(change.parent === undefined ? {} : { parent: change.parent }),
        },
      },
      { reportFailure: false },
    );
  const editStructure = async (change: StructureChange) => {
    const over = issue.readAt;
    setPending((current) => ({ ...(current?.over === over ? current : {}), ...change, over }));
    setStructureError(null);
    const result = await updateStructure(issue.number, change);
    if (result._tag === "Success") {
      // Both parents' sub-issue lists changed.
      for (const number of [parent, change.parent]) if (number != null) refreshDetail(number);
      return;
    }
    setPending(null);
    if (!isAtomCommandInterrupted(result)) {
      setStructureError(failureText(result, "GitHub did not change the issue."));
    }
  };
  /** A parent with a milestone gives it to a part that has none. */
  const inheritedMilestone = (
    part: { readonly milestone: StructureChange["milestone"] },
    from: StructureChange["milestone"],
  ) => (part.milestone == null && from ? { milestone: from } : {});
  const chooseParent = (choice: IssueList["issues"][number] | null) =>
    void editStructure(
      choice === null
        ? { parent: null }
        : { parent: choice.number, ...inheritedMilestone({ milestone }, choice.milestone) },
    );
  const addExisting = async (choice: IssueList["issues"][number]) => {
    setStructureError(null);
    const result = await updateStructure(choice.number, {
      parent: issue.number,
      ...inheritedMilestone(choice, milestone),
    });
    if (result._tag === "Success") refreshDetail(issue.number);
    else if (!isAtomCommandInterrupted(result)) {
      setStructureError(failureText(result, `GitHub did not move #${choice.number}.`));
    }
  };
  const repository = new URL(issue.url).pathname.split("/").slice(1, 3).join("/");

  const markdown = (text: string) => (
    <ChatMarkdown
      text={text}
      cwd={props.project?.workspaceRoot}
      environmentId={owner.environmentId}
      sourceControlMedia
    />
  );

  const open = issue.state === "open";
  return (
    <DetailLayout
      crumb={
        <>
          <span className="truncate">{props.project?.title}</span>
          <span aria-hidden>›</span>
          <FeatureIssueIcon issue={row} className="size-3.5" />
          <span className="shrink-0 font-mono">#{issue.number}</span>
        </>
      }
      actions={
        <>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Refresh from GitHub"
            title={`${repository} · read from GitHub ${formatRelativeTimeLabel(issue.readAt)}`}
            disabled={detail.isPending}
            onClick={detail.refresh}
          >
            <RefreshCwIcon aria-hidden />
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => void readLocalApi()?.shell.openExternal(issue.url)}
          >
            <ExternalLinkIcon aria-hidden />
            GitHub
          </Button>
          {open && !feature ? (
            <StartFeatureButton onStart={() => startFeature(todoProject(row), { issue: row })} />
          ) : null}
          {open ? <CloseTodoButton todo={row} /> : <ReopenTodoButton todo={row} />}
        </>
      }
    >
      <DetailTitle className="sr-only">{issue.title}</DetailTitle>
      <div className="flex flex-col gap-1">
        <IssueTitleField key={issue.title} title={issue.title} save={save} editable={canEdit} />
        <p className="text-xs text-muted-foreground">
          {issue.author?.login ?? "Someone"} opened this {formatRelativeTimeLabel(issue.createdAt)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip>
          <span className="font-medium text-foreground">
            {open ? "Open" : ISSUE_CLOSED_LABELS[issue.closedReason ?? "completed"]}
          </span>
        </Chip>
        <FeatureChip feature={feature} />
        <MilestoneChip
          milestone={milestone}
          milestones={props.issueList?.milestones ?? []}
          editable={canEdit}
          onChange={(change) => void editStructure(change)}
          onShowOnBoard={() => {
            if (!milestone) return;
            closeTodo();
            showOnBoard(owner, milestone.number);
          }}
        />
        <ParentChip
          parent={parent}
          parentTitle={parentTitle}
          choices={choices}
          editable={canEdit}
          onOpen={openIssue}
          onChange={chooseParent}
        />
        {issue.labels.map((label) => (
          <Chip key={label.name}>
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: `#${label.color}` }}
            />
            <span className="truncate">{label.name}</span>
          </Chip>
        ))}
        {issue.assignees.map((assignee) => (
          <Chip key={assignee.login}>
            <img
              src={assignee.avatarUrl}
              alt=""
              loading="lazy"
              className="size-4 shrink-0 rounded-full bg-muted"
            />
            {assignee.login}
          </Chip>
        ))}
      </div>
      {structureError ? (
        <p role="alert" className="text-sm text-destructive">
          {structureError}
        </p>
      ) : null}
      <DescriptionBody
        text={issue.body}
        version={issue.updatedAt}
        save={(body) => save({ body })}
        uploadImage={(file) => uploadTodoImage("issue", owner, file)}
        markdown={markdown}
        editable={canEdit}
      />
      <SubIssuesSection
        owner={owner}
        issue={issue}
        refreshing={detail.isPending && issue.subIssueList === null}
        onRetry={detail.refresh}
        loaded={loadedIssues}
        choices={choices.filter((choice) => choice.number !== parent)}
        editable={canEdit}
        featureFor={props.featureFor}
        onOpen={openIssue}
        onStart={(part) => startFeature(todoProject(part), { issue: part })}
        onAddExisting={(choice) => void addExisting(choice)}
        onNew={() =>
          openNewTodoDialog({
            project: owner,
            parent: issue.number,
            ...(milestone ? { milestone: milestone.number } : {}),
          })
        }
      />
      {issue.commentCount > 0 ? (
        <section className="mt-4 flex flex-col">
          <h3 className="pb-2 text-xs text-muted-foreground">
            {issue.commentCount === 1 ? "1 comment" : `${issue.commentCount} comments`}
          </h3>
          {issue.comments.map((comment) => (
            <div key={comment.url} className="border-t border-border py-3">
              <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                {comment.author ? (
                  <img
                    src={comment.author.avatarUrl}
                    alt=""
                    loading="lazy"
                    className="size-5 rounded-full bg-muted"
                  />
                ) : null}
                <span className="font-medium text-foreground">
                  {comment.author?.login ?? "ghost"}
                </span>
                <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
              </div>
              <div className="ps-7">{markdown(comment.body)}</div>
            </div>
          ))}
          {issue.commentCount > issue.comments.length ? (
            <Button
              variant="ghost-muted"
              size="sm"
              onClick={() => void readLocalApi()?.shell.openExternal(issue.url)}
            >
              {issue.commentCount - issue.comments.length} more on GitHub
            </Button>
          ) : null}
        </section>
      ) : null}
    </DetailLayout>
  );
}
