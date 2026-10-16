import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, FeatureIssue, ProjectId } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDotIcon } from "lucide-react";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { featuresEnvironment } from "../../state/features";
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

/** Open issues in green and closed ones in the primary color, close to how GitHub shows them. */
export function FeatureIssueIcon(props: {
  readonly issue: Pick<FeatureIssue, "state">;
  readonly className?: string;
}) {
  const Icon = props.issue.state === "open" ? CircleDotIcon : CircleCheckIcon;
  return (
    <Icon
      aria-label={props.issue.state === "open" ? "Open issue" : "Closed issue"}
      className={cn(
        "shrink-0",
        props.issue.state === "open" ? "text-success" : "text-primary",
        props.className,
      )}
    />
  );
}

/** "v0.4 · 1/3 sub-issues", or null when the issue has neither. */
export function featureIssueMeta(issue: FeatureIssue): string | null {
  const parts = [
    issue.milestone,
    issue.subIssues ? `${issue.subIssues.completed}/${issue.subIssues.total} sub-issues` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface FeatureIssueTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly featureId: string;
  readonly featureTitle: string;
  readonly issue: FeatureIssue | null;
}

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

const close = () => appAtomRegistry.set(featureIssueDialogAtom, null);

export function FeatureIssueDialogHost() {
  const target = useAtomValue(featureIssueDialogAtom);
  if (target === null) return null;
  return <FeatureIssueDialog key={target.featureId} target={target} />;
}

function FeatureIssueDialog({ target }: { readonly target: FeatureIssueTarget }) {
  const [url, setUrl] = useState(target.issue?.url ?? "");
  const [busy, setBusy] = useState<"link" | "unlink" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: string | null) => {
    setBusy(next === null ? "unlink" : "link");
    setError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      featuresEnvironment.setIssue,
      {
        environmentId: target.environmentId,
        input: { projectId: target.projectId, featureId: target.featureId, url: next },
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
          <DialogTitle>{target.issue ? "Feature issue" : "Link an issue"}</DialogTitle>
          <DialogDescription>
            Every thread of <span className="font-medium">{target.featureTitle}</span> shows the
            issue it works on. A feature has one issue.
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
                placeholder="https://github.com/owner/repo/issues/123"
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
            <Button
              type="submit"
              disabled={busy !== null || !url.trim() || url.trim() === target.issue?.url}
            >
              {target.issue ? "Replace" : "Link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
