import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  featureIssueRef,
  ticketRef,
  type EnvironmentId,
  type FeatureIssue,
  type ProjectId,
  type ThreadFeatureTag,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { CheckIcon, LinkIcon, NotebookTextIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { featuresEnvironment } from "../../state/features";
import { openFeatureIssue } from "../features/todoDialogs";
import { useEnvironmentQuery } from "../../state/query";
import { Command, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { FeatureIssueIcon } from "./FeatureIssueIcon";

/** "v0.4 · 1/3 sub-issues", or null when the issue has neither. */
export function featureIssueMeta(issue: FeatureIssue): string | null {
  const parts = [
    issue.milestone,
    issue.subIssues ? `${issue.subIssues.completed}/${issue.subIssues.total} sub-issues` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** A feature's issue shows on every thread of it; a thread's own issue on that thread alone. */
export type FeatureIssueTarget = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly issue: FeatureIssue | null;
} & (
  | { readonly featureId: string; readonly featureTitle: string; readonly threadId?: never }
  | { readonly threadId: ThreadId; readonly threadTitle: string; readonly featureId?: never }
);

/**
 * The feature the issue dialog is open for. Set from the board, the sidebar and the details
 * panel, and rendered once at the root so it outlives the menu that opened it.
 */
const featureIssueDialogAtom = Atom.make<FeatureIssueTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("features:issue-dialog"),
);

export function openFeatureIssueDialog(target: FeatureIssueTarget): void {
  appAtomRegistry.set(featureIssueDialogAtom, target);
}

/**
 * A thread menu's issue item: opens the issue, or the dialog that links one. A feature's thread
 * works on the feature's issue; any other thread links its own.
 */
export function runFeatureIssueAction(
  action: "feature-issue" | "feature-open-issue",
  thread: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly id: ThreadId;
    readonly title: string;
    readonly feature?: ThreadFeatureTag | null | undefined;
    readonly issue?: FeatureIssue | null | undefined;
  },
): void {
  const { feature } = thread;
  const issue = (feature ? feature.issue : thread.issue) ?? null;
  if (action === "feature-open-issue") {
    if (issue) openFeatureIssue(thread, issue);
    return;
  }
  const where = { environmentId: thread.environmentId, projectId: thread.projectId, issue };
  openFeatureIssueDialog(
    feature
      ? { ...where, featureId: feature.id, featureTitle: feature.title }
      : { ...where, threadId: thread.id, threadTitle: thread.title },
  );
}

const close = () => appAtomRegistry.set(featureIssueDialogAtom, null);

export function FeatureIssueDialogHost() {
  const target = useAtomValue(featureIssueDialogAtom);
  if (target === null) return null;
  return <FeatureIssueDialog key={target.featureId ?? target.threadId} target={target} />;
}

/** One issue or ticket the picker offers, with the reference the link takes. */
interface IssueChoice {
  readonly key: string;
  /** What `setIssue` reads: the issue's link, or the ticket's `T-<number>`. */
  readonly link: string;
  readonly ref: string;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly updatedAt: string;
  readonly ticket: boolean;
}

/** A link, `#12`, `T-3` or a tracker key: worth offering as typed when no row matches. */
const LINKABLE = /^(?:https?:\/\/\S+|#\d+|T-\d+|[A-Z][A-Z0-9]+-\d+)$/iu;

function FeatureIssueDialog({ target }: { readonly target: FeatureIssueTarget }) {
  const owner = { environmentId: target.environmentId, input: { projectId: target.projectId } };
  const issues = useEnvironmentQuery(featuresEnvironment.issues(owner));
  const tickets = useEnvironmentQuery(featuresEnvironment.tickets(owner));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: string | null) => {
    setBusy(true);
    setError(null);
    const result =
      target.threadId === undefined
        ? await runAtomCommand(
            appAtomRegistry,
            featuresEnvironment.setIssue,
            {
              environmentId: target.environmentId,
              input: { projectId: target.projectId, featureId: target.featureId, url: next },
            },
            { reportFailure: false },
          )
        : await runAtomCommand(
            appAtomRegistry,
            featuresEnvironment.setThreadIssue,
            {
              environmentId: target.environmentId,
              input: { threadId: target.threadId, url: next },
            },
            { reportFailure: false },
          );
    setBusy(false);
    if (result._tag === "Success") close();
    else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error
          ? failure.message.replace(/^\w*Error: /, "")
          : "Could not link the issue.",
      );
    }
  };

  const linked = target.issue ? featureIssueRef(target.issue) : null;
  const choices: ReadonlyArray<IssueChoice> = [
    ...(tickets.data ?? []).map((ticket) => ({
      key: `ticket:${ticket.id}`,
      link: ticketRef(ticket),
      ref: ticketRef(ticket),
      title: ticket.title,
      state: ticket.state,
      updatedAt: ticket.updatedAt,
      ticket: true,
    })),
    ...(issues.data?.issues ?? []).map((issue) => ({
      key: `issue:${issue.number}`,
      link: issue.url,
      ref: `#${issue.number}`,
      title: issue.title,
      state: issue.state,
      updatedAt: issue.updatedAt,
      ticket: false,
    })),
  ].toSorted(
    (a, b) =>
      Number(b.state === "open") - Number(a.state === "open") ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
  const search = query.trim().toLocaleLowerCase();
  const shown = choices.filter((choice) =>
    `${choice.ref} ${choice.title}`.toLocaleLowerCase().includes(search),
  );
  const typed =
    LINKABLE.test(query.trim()) &&
    !shown.some((choice) => choice.ref.toLocaleLowerCase() === search)
      ? query.trim()
      : null;
  const loading = issues.data === null && tickets.data === null;

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : close())}>
      <DialogPopup className="max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">
          {target.threadId === undefined
            ? `Link an issue to ${target.featureTitle}`
            : `Link an issue to ${target.threadTitle}`}
        </DialogTitle>
        <Command mode="none" value={query} onValueChange={setQuery} aria-label="Choose an issue">
          <CommandInput placeholder="Search issues and tickets, or paste a link…" disabled={busy} />
          <CommandList className="max-h-80 overflow-y-auto">
            {typed ? (
              <CommandItem value="typed" disabled={busy} onClick={() => void save(typed)}>
                <LinkIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">Link {typed}</span>
              </CommandItem>
            ) : null}
            {shown.map((choice) => (
              <CommandItem
                key={choice.key}
                value={choice.key}
                disabled={busy}
                onClick={() => (choice.ref === linked ? close() : void save(choice.link))}
              >
                {choice.ticket ? (
                  <NotebookTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FeatureIssueIcon issue={choice} className="size-4" />
                )}
                <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">
                  {choice.ref}
                </span>
                <span className="min-w-0 flex-1 truncate">{choice.title}</span>
                {choice.ref === linked ? (
                  <CheckIcon aria-label="Linked" className="size-3.5" />
                ) : null}
              </CommandItem>
            ))}
            {shown.length === 0 && !typed ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {loading
                  ? "Loading issues…"
                  : search
                    ? "No issue or ticket matches. Paste a link, #number or T-number."
                    : (issues.data?.unavailable ?? "No issues or tickets yet.")}
              </div>
            ) : null}
            {linked ? (
              <CommandItem value="unlink" disabled={busy} onClick={() => void save(null)}>
                <UnlinkIcon aria-hidden className="size-4 shrink-0 text-destructive" />
                <span className="text-destructive">Unlink {linked}</span>
              </CommandItem>
            ) : null}
          </CommandList>
        </Command>
        {error ? (
          <p role="alert" className="border-t px-4 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
