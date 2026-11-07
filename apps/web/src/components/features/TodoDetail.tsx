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
  type Ticket,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  CircleDotIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  ListTreeIcon,
  MilestoneIcon,
  NotebookTextIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

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
  closeTodo,
  openTodo,
  todoDetailAtom,
  type TodoOwner,
  type TodoTarget,
} from "./todoDialogs";
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
      project={project}
      featureFor={(row) => featureForIssue(features, row)}
    />
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-6">
      <SheetTitle className="sr-only">Loading</SheetTitle>
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/** A todo that is gone, or one that couldn't be read, which is a different problem. */
function Gone(props: { readonly text: string; readonly failed?: boolean }) {
  return (
    <div className="p-6">
      <SheetTitle>{props.failed ? "Couldn't load this todo" : "Todo not found"}</SheetTitle>
      <p className="mt-2 text-sm text-muted-foreground">{props.text}</p>
    </div>
  );
}

/** One column: a header with the todo's place and actions, then the todo as a document. */
function DetailLayout(props: {
  readonly crumb: ReactNode;
  readonly actions: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The end padding leaves room for the sheet's close button. */}
      <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border ps-5 pe-12 text-xs text-muted-foreground">
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

function StartFeatureButton(props: { readonly onStart: () => void }) {
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
      openTodo({ ...target, projectId: ticket.projectId, number: result.value.number });
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
      <SheetTitle className="sr-only">{ticket.title}</SheetTitle>
      <textarea
        aria-label="Title"
        rows={1}
        value={title}
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
function IssueTitleField(props: { readonly title: string; readonly save: SaveIssueEdit }) {
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
      readOnly={saving}
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
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Handlers outlive their render while an upload runs, so they read the live count.
  const uploads = useRef(0);
  const [uploading, setUploading] = useState(0);
  // Shown after a save until the refreshed read lands, so the old text doesn't flash back.
  const [saved, setSaved] = useState<{ body: string; over: string } | null>(null);
  const shown = saved !== null && saved.over === props.version ? saved.body : props.text;
  const sent = useRef(shown);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = async (body: string) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (body === sent.current) return true;
    const previous = sent.current;
    sent.current = body;
    setSaving(true);
    const ok = await props.save(body);
    setSaving(false);
    if (ok) setSaved({ body, over: props.version });
    else sent.current = previous;
    return ok;
  };
  const change = (body: string) => {
    setDraft(body);
    if (timer.current !== null) clearTimeout(timer.current);
    // Saving now would store an upload's placeholder; the image's own change saves.
    if (uploads.current > 0) return;
    timer.current = setTimeout(() => void flush(body), DESCRIPTION_SAVE_DELAY_MS);
  };
  const upload = (file: File) => {
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
    sent.current = shown;
    setOpenedAt(point);
    setDraft(shown);
  };

  // One element in both modes: removing the focused one would make the sheet pull focus back to
  // itself, which reads as leaving the editor and closes it as soon as it opens.
  const editing = draft !== null;
  return (
    <div
      tabIndex={editing ? -1 : 0}
      aria-label={editing ? undefined : "Description. Press Enter to edit."}
      className={cn(
        "-mx-2 mt-1 flex flex-col gap-1 rounded-md px-2 py-1 outline-none",
        !editing &&
          "cursor-text hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      )}
      onClick={(event) => {
        if (editing) return;
        // Links, buttons and a text selection keep their own clicks.
        if ((event.target as Element).closest("a, button, summary, input, img")) return;
        if (window.getSelection()?.toString()) return;
        startEditing({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (editing || event.key !== "Enter" || event.target !== event.currentTarget) return;
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
          // Leaving keeps the editor open only when the save failed, so nothing typed is lost.
          void flush(draft).then((ok) => ok && setDraft(null));
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
  readonly project: EnvironmentProject | null;
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
  if (!issue) {
    return detail.error ? <Gone text={detail.error} failed /> : <DetailSkeleton />;
  }
  const row: EnvironmentIssue = { ...issue, ...owner, ticketId: null };
  const feature = props.featureFor(row);
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
      <SheetTitle className="sr-only">{issue.title}</SheetTitle>
      <div className="flex flex-col gap-1">
        <IssueTitleField key={issue.title} title={issue.title} save={save} />
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
        {issue.milestone ? (
          <Chip>
            <MilestoneIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{issue.milestone.title}</span>
          </Chip>
        ) : null}
        {issue.subIssues ? (
          <Chip>
            <ListTreeIcon aria-hidden className="size-3.5 shrink-0" />
            {issue.subIssues.completed}/{issue.subIssues.total}
          </Chip>
        ) : null}
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
      <DescriptionBody
        text={issue.body}
        version={issue.updatedAt}
        save={(body) => save({ body })}
        uploadImage={(file) => uploadTodoImage("issue", owner, file)}
        markdown={markdown}
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
