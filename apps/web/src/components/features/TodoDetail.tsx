import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentFeatureCard } from "@t3tools/client-runtime/state/crew-board";
import {
  ISSUE_LANE_LABELS,
  featureForIssue,
  featuresByIssue,
  issueLane,
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
  CircleDotIcon,
  ExternalLinkIcon,
  ListTreeIcon,
  MilestoneIcon,
  NotebookTextIcon,
  PlayIcon,
  RefreshCwIcon,
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { featureOwnerLine, featureStatus } from "./FeatureCard";
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
      <SheetPopup side="right" className="w-[min(94vw,56rem)] max-w-[56rem]">
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

/** The sheet's two columns: the todo itself, and its properties and actions. */
function DetailLayout(props: {
  readonly banner?: ReactNode;
  readonly crumb: ReactNode;
  readonly main: ReactNode;
  readonly side: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {props.banner}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="flex min-w-0 flex-col gap-3 p-6 md:border-e md:border-border">
          <div className="flex items-center gap-1.5 pe-8 text-xs text-muted-foreground">
            {props.crumb}
          </div>
          {props.main}
        </div>
        {/* Without a banner, the side column's top sits under the sheet's close button. */}
        <div className={cn("flex min-w-0 flex-col gap-1 p-4 text-sm", !props.banner && "md:pt-12")}>
          {props.side}
        </div>
      </div>
    </div>
  );
}

function Property(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">{props.children}</div>
    </div>
  );
}

/** The feature working on a todo, which opens it; or a Start button for an open todo. */
function FeatureProperty(props: {
  readonly feature: EnvironmentFeatureCard | null;
  readonly onStart: (() => void) | null;
}) {
  const navigate = useNavigate();
  const { feature } = props;
  if (!feature) {
    return props.onStart ? (
      <Button size="xs" variant="outline" onClick={props.onStart}>
        <PlayIcon aria-hidden />
        Start feature
      </Button>
    ) : (
      <span className="text-muted-foreground">None</span>
    );
  }
  const status = featureStatus(feature, undefined);
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
            className="inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/70 px-1.5 text-xs text-muted-foreground hover:border-border hover:text-foreground"
          />
        }
      >
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full bg-current", status.className)}
        />
        <span className="truncate">{featureOwnerLine(feature)}</span>
      </TooltipTrigger>
      <TooltipPopup>
        {feature.title} · {status.label}
      </TooltipPopup>
    </Tooltip>
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
  const lane = issueLane(row, feature);

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

  return (
    <DetailLayout
      crumb={
        <>
          <span className="truncate">{props.project?.title}</span>
          <span aria-hidden>›</span>
          <NotebookTextIcon aria-hidden className="size-3.5" />
          <span className="font-mono">{ticketRef(ticket)}</span>
        </>
      }
      main={
        <>
          <SheetTitle className="sr-only">{ticket.title}</SheetTitle>
          <input
            aria-label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="w-full bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground"
          />
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
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {busy === "save" ? "Saving…" : `Updated ${formatRelativeTimeLabel(ticket.updatedAt)}`}
            </p>
          )}
        </>
      }
      side={
        <>
          <Property label="Status">
            <Select
              value={ticketStatus(ticket)}
              onValueChange={(value) => {
                if (value === null || value === ticketStatus(ticket)) return;
                void update(
                  value === "open"
                    ? { state: "open" }
                    : { state: "closed", closedReason: value as Exclude<TicketStatus, "open"> },
                );
              }}
            >
              <SelectTrigger aria-label="Status" size="xs" className="min-w-0">
                <SelectValue>{TICKET_STATUSES[ticketStatus(ticket)]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {Object.entries(TICKET_STATUSES).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Property>
          <Property label="Lane">{ISSUE_LANE_LABELS[lane]}</Property>
          <Property label="Feature">
            <FeatureProperty
              feature={feature}
              onStart={ticket.state === "open" ? () => void startFeature(row, description) : null}
            />
          </Property>
          <Property label="Created">{formatRelativeTimeLabel(ticket.createdAt)}</Property>
          <div className="my-2 h-px bg-border" />
          {props.canFileIssues ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void move()}
            >
              <CircleDotIcon aria-hidden />
              Move to GitHub issue
            </Button>
          ) : null}
          <Button
            variant="destructive-outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void remove()}
          >
            Delete
          </Button>
        </>
      }
    />
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

  return (
    <DetailLayout
      banner={
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 py-1.5 ps-6 pe-12 text-xs text-muted-foreground">
          <CircleDotIcon aria-hidden className="size-3.5" />
          <span className="truncate">
            {repository} · read from GitHub {formatRelativeTimeLabel(issue.readAt)}
          </span>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Refresh"
            disabled={detail.isPending}
            onClick={detail.refresh}
            className="ms-auto"
          >
            <RefreshCwIcon aria-hidden />
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => void readLocalApi()?.shell.openExternal(issue.url)}
          >
            <ExternalLinkIcon aria-hidden />
            Open on GitHub
          </Button>
        </div>
      }
      crumb={
        <>
          <span className="truncate">{props.project?.title}</span>
          <span aria-hidden>›</span>
          <span className="font-mono">#{issue.number}</span>
        </>
      }
      main={
        <>
          <SheetTitle className="sr-only">{issue.title}</SheetTitle>
          <h2 className="text-xl font-semibold leading-snug">{issue.title}</h2>
          <p className="text-xs text-muted-foreground">
            {issue.author?.login ?? "Someone"} opened this{" "}
            {formatRelativeTimeLabel(issue.createdAt)}
          </p>
          {issue.body.trim() ? (
            markdown(issue.body)
          ) : (
            <p className="text-sm text-muted-foreground">No description.</p>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="mt-2 flex flex-col gap-3 border-t border-border pt-4">
            <h3 className="text-sm font-medium">
              {issue.commentCount === 1 ? "1 comment" : `${issue.commentCount} comments`}
            </h3>
            {issue.comments.map((comment) => (
              <div key={comment.url} className="rounded-lg border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
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
                {markdown(comment.body)}
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
          </div>
        </>
      }
      side={
        <>
          <Property label="Status">
            {issue.state === "open"
              ? "Open"
              : ISSUE_CLOSED_LABELS[issue.closedReason ?? "completed"]}
          </Property>
          <Property label="Lane">{ISSUE_LANE_LABELS[issueLane(row, feature)]}</Property>
          {issue.labels.length > 0 ? (
            <Property label="Labels">
              {issue.labels.map((label) => (
                <span
                  key={label.name}
                  className="inline-flex h-5 max-w-full items-center gap-1 rounded-full border border-border/70 px-1.5 text-2xs text-muted-foreground"
                >
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: `#${label.color}` }}
                  />
                  <span className="truncate">{label.name}</span>
                </span>
              ))}
            </Property>
          ) : null}
          {issue.assignees.length > 0 ? (
            <Property label="Assignees">
              {issue.assignees.map((assignee) => (
                <span key={assignee.login} className="inline-flex items-center gap-1.5">
                  <img
                    src={assignee.avatarUrl}
                    alt=""
                    loading="lazy"
                    className="size-4 rounded-full bg-muted"
                  />
                  {assignee.login}
                </span>
              ))}
            </Property>
          ) : null}
          {issue.milestone ? (
            <Property label="Milestone">
              <MilestoneIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">{issue.milestone.title}</span>
            </Property>
          ) : null}
          {issue.subIssues ? (
            <Property label="Sub-issues">
              <ListTreeIcon aria-hidden className="size-3.5 text-muted-foreground" />
              {issue.subIssues.completed} / {issue.subIssues.total}
            </Property>
          ) : null}
          <Property label="Feature">
            <FeatureProperty
              feature={feature}
              onStart={issue.state === "open" ? () => void startFeature(row) : null}
            />
          </Property>
          <div className="my-2 h-px bg-border" />
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void setState(issue.state === "open" ? "closed" : "open")}
          >
            {issue.state === "open" ? "Close issue" : "Reopen issue"}
          </Button>
        </>
      }
    />
  );
}
