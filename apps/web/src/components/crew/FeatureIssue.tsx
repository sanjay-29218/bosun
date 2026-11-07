import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  featureIssueRef,
  type EnvironmentId,
  type FeatureIssue,
  type ProjectId,
  type ThreadFeatureTag,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { featuresEnvironment } from "../../state/features";
import { openFeatureIssue } from "../features/todoDialogs";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

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

function FeatureIssueDialog({ target }: { readonly target: FeatureIssueTarget }) {
  const current = target.issue
    ? target.issue.ticketId === undefined
      ? target.issue.url
      : featureIssueRef(target.issue)
    : "";
  const [url, setUrl] = useState(current);
  const [busy, setBusy] = useState<"link" | "unlink" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: string | null) => {
    setBusy(next === null ? "unlink" : "link");
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
    setBusy(null);
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

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : close())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {target.issue
              ? target.threadId === undefined
                ? "Feature issue"
                : "Thread issue"
              : "Link an issue"}
          </DialogTitle>
          <DialogDescription>
            {target.threadId === undefined ? (
              <>
                Every thread of <span className="font-medium">{target.featureTitle}</span> shows the
                issue or ticket it works on. A feature has one.
              </>
            ) : (
              <>
                <span className="font-medium">{target.threadTitle}</span> shows the issue or ticket
                it works on, and opens it from its details.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim() && !busy) void save(url.trim());
          }}
        >
          <DialogPanel>
            <div className="space-y-2">
              <Input
                autoFocus
                aria-label="Issue link"
                placeholder="https://github.com/owner/repo/issues/123, #123 or T-14"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            {target.issue ? (
              <Button
                type="button"
                variant="destructive-outline"
                className="me-auto"
                disabled={busy !== null}
                onClick={() => void save(null)}
              >
                Unlink
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={close} disabled={busy !== null}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy !== null || !url.trim() || url.trim() === current}>
              {target.issue ? "Replace" : "Link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
