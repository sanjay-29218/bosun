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
import { ticketRef, type EnvironmentId, type IssueDetail, type Ticket } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
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

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProjects } from "../../state/entities";
import { featuresEnvironment } from "../../state/features";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { InstructionsEditor } from "../InstructionsEditor";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FeatureIssueIcon } from "../crew/FeatureIssue";
import { featureStatus } from "./FeatureCard";
import { cn } from "../../lib/utils";
import {
  closeTodo,
  openTodo,
  todoDetailAtom,
  type TodoOwner,
  type TodoTarget,
} from "./todoDialogs";

/**
 * Starts a feature on a todo: a new thread in its project whose brief names it. The composer's
 * Workflow picker starts it, and creating the feature links the issue's URL or the ticket's
 * `Ticket T-<number>` line.
 */
export function useStartFeatureFromTodo() {
  const newThread = useNewThreadHandler();
  return async (todo: EnvironmentIssue, description?: string) => {
    const created = await newThread(scopeProjectRef(todo.environmentId, todo.projectId));
    if (!created) return;
    const drafts = useComposerDraftStore.getState();
    const brief = todo.ticketId
      ? [todo.title, description?.trim(), `Ticket ${ticketRef(todo)}`].filter(Boolean).join("\n\n")
      : `${todo.title}\n\n${todo.url}`;
    // A reused draft keeps what was already written.
    const existing = drafts.getComposerDraft(created.draftId)?.prompt.trim() ?? "";
    drafts.setPrompt(created.draftId, existing ? `${existing}\n\n${brief}` : brief);
    closeTodo();
  };
}

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message.replace(/^\w*Error: /, "") : fallback;
};

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
        <Gone text={tickets.error ?? "This ticket was moved or deleted."} />
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

function Gone(props: { readonly text: string }) {
  return (
    <div className="p-6">
      <SheetTitle>Todo not found</SheetTitle>
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

/** The feature working on a todo, as its live status; opening it shows the feature's thread. */
function FeatureChip(props: { readonly feature: EnvironmentFeatureCard | null }) {
  const navigate = useNavigate();
  const { feature } = props;
  if (!feature) return <Chip>No feature yet</Chip>;
  const status = featureStatus(feature, undefined);
  const StatusIcon = status.icon;
  const threadId = feature.threadId;
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
  const [description, setDescription] = useState(ticket.description);
  const [busy, setBusy] = useState<"save" | "move" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startFeature = useStartFeatureFromTodo();
  const row = ticketIssue(ticket, props.environmentId);
  const target = { environmentId: props.environmentId };

  const update = async (patch: {
    readonly title?: string;
    readonly description?: string;
    readonly state?: "open" | "closed";
    readonly closedReason?: "completed" | "not_planned";
  }) => {
    setBusy("save");
    setError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      featuresEnvironment.updateTicket,
      { ...target, input: { projectId: ticket.projectId, ticketId: ticket.id, ...patch } },
      { reportFailure: false },
    );
    setBusy(null);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      setError(failureText(result, "The ticket could not be saved."));
    }
  };

  // A pause in typing saves the description, so closing the sheet mid-edit keeps it.
  const descriptionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveDescription = (next: string) => {
    if (descriptionTimer.current !== null) clearTimeout(descriptionTimer.current);
    descriptionTimer.current = null;
    if (next !== ticket.description) void update({ description: next });
  };
  const changeDescription = (next: string) => {
    setDescription(next);
    if (descriptionTimer.current !== null) clearTimeout(descriptionTimer.current);
    descriptionTimer.current = setTimeout(() => saveDescription(next), DESCRIPTION_SAVE_DELAY_MS);
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
            <StartFeatureButton onStart={() => void startFeature(row, description)} />
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
      <div
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          saveDescription(description);
        }}
      >
        <InstructionsEditor
          label="Description"
          value={description}
          onChange={changeDescription}
          placeholder="Add a description…"
          size="lg"
          variant="document"
        />
      </div>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startFeature = useStartFeatureFromTodo();
  const issue = detail.data;
  if (!issue) {
    return detail.error ? <Gone text={detail.error} /> : <DetailSkeleton />;
  }
  const row: EnvironmentIssue = { ...issue, ...owner, ticketId: null };
  const feature = props.featureFor(row);
  const repository = new URL(issue.url).pathname.split("/").slice(1, 3).join("/");

  const setState = async (state: "open" | "closed") => {
    setBusy(true);
    setError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      featuresEnvironment.setIssueState,
      {
        environmentId: owner.environmentId,
        input: { projectId: owner.projectId, number: issue.number, state },
      },
      { reportFailure: false },
    );
    setBusy(false);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      setError(failureText(result, "GitHub did not change the issue."));
    }
  };
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
          {open && !feature ? <StartFeatureButton onStart={() => void startFeature(row)} /> : null}
          <MoreActions>
            <MenuItem disabled={busy} onClick={() => void setState(open ? "closed" : "open")}>
              {open ? "Close issue" : "Reopen issue"}
            </MenuItem>
          </MoreActions>
        </>
      }
    >
      <SheetTitle className="sr-only">{issue.title}</SheetTitle>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold leading-snug">{issue.title}</h2>
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
      <div className="mt-2">
        {issue.body.trim() ? (
          markdown(issue.body)
        ) : (
          <p className="text-sm text-muted-foreground">No description.</p>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
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
