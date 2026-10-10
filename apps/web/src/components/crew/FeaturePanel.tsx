import {
  CREW_STATE_LABELS,
  featureStageRows,
  formatStageName,
  type FeatureStageRow,
} from "@t3tools/client-runtime/crew-stage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { CREW_ACTION_COPY } from "./crewActionCopy";
import { useCrewStageContext } from "./useCrewStage";

const STEP_STATUS: Record<FeatureStageRow["status"], { label: string; className: string }> = {
  pending: { label: "Next", className: "text-muted-foreground" },
  running: { label: "Working", className: "text-info" },
  "needs-input": { label: "Input", className: "text-indigo-600 dark:text-indigo-300" },
  completed: { label: "Done", className: "text-success" },
  failed: { label: "Failed", className: "text-error" },
  cancelled: { label: "Cancelled", className: "text-muted-foreground" },
  "awaiting-approval": { label: "Approval", className: "text-warning-foreground" },
  "limit-reached": { label: "Your call", className: "text-warning-foreground" },
  "taken-over": { label: "Yours", className: "text-foreground" },
  skipped: { label: "Skipped", className: "text-muted-foreground" },
};

function SectionTitle({ children }: { readonly children: string }) {
  return <h3 className="px-1 text-xs font-medium text-muted-foreground">{children}</h3>;
}

/** The Feature tab: a stage thread's feature, its stages, outputs and workspace. */
export function FeaturePanel(props: { readonly onEditWorkflow: () => void }) {
  const stage = useCrewStageContext();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!stage) {
    return (
      <p className="p-4 text-sm text-muted-foreground">This thread isn't part of a feature.</p>
    );
  }
  const { snapshot, thread, crew } = stage;
  if (!snapshot) {
    return <p className="p-4 text-sm text-muted-foreground">Loading the feature…</p>;
  }
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, threadId)),
    });
  const run = async (action: Parameters<typeof stage.run>[0]) => {
    setBusy(true);
    try {
      await stage.run(action);
    } finally {
      setBusy(false);
    }
  };
  const rows = featureStageRows(snapshot);
  const activeTask = snapshot.activeStepId
    ? snapshot.definition.steps[snapshot.activeStepId]
    : undefined;
  const supervisor =
    activeTask?.type === "task" ? snapshot.definition.bots[activeTask.bot]?.supervisor : null;
  const pullRequest = thread.linkedPullRequest ?? thread.branchPullRequest ?? null;
  const footer = (["start-now", "pause", "resume", "cancel", "reopen"] as const).filter((action) =>
    stage.actions.includes(action),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-4 p-3 text-sm">
        <header className="flex items-baseline justify-between gap-2 px-1">
          <span className="truncate font-medium">
            {snapshot.definition.name} · v{snapshot.definition.revision}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {CREW_STATE_LABELS[snapshot.state ?? crew.state]}
          </span>
        </header>

        <section className="flex flex-col gap-1">
          <SectionTitle>Stages</SectionTitle>
          <ol className="flex flex-col">
            {rows.map((row) => {
              const status = STEP_STATUS[row.status];
              const content = (
                <>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{row.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {row.bot}
                      {row.gate ? " · approval gate" : ""}
                      {row.attempt > 1 ? ` · attempt ${row.attempt}` : ""}
                    </span>
                  </span>
                  <span className={cn("shrink-0 text-xs", status.className)}>{status.label}</span>
                </>
              );
              const className = cn(
                "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left",
                row.active && "bg-accent",
              );
              return (
                <li key={row.stepId}>
                  {row.threadId ? (
                    <button
                      type="button"
                      className={cn(className, "cursor-pointer hover:bg-accent")}
                      aria-current={row.threadId === thread.id ? "page" : undefined}
                      onClick={() => openThread(row.threadId!)}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className={className}>{content}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>

        {snapshot.outputs && snapshot.outputs.length > 0 ? (
          <section className="flex flex-col gap-1">
            <SectionTitle>Outputs</SectionTitle>
            <ul className="flex flex-col">
              {snapshot.outputs.map((output) => (
                <li
                  key={output.kind === "file" ? `file:${output.path}` : `diff:${output.stepId}`}
                  className="flex items-center justify-between gap-2 px-2 py-1"
                >
                  <span className="min-w-0 truncate">
                    {output.kind === "file" ? (
                      <>
                        <span className="font-mono">{output.path}</span> v{output.version} ·{" "}
                        {formatStageName(output.stepId)}
                      </>
                    ) : (
                      <>
                        {formatStageName(output.stepId)} diff{" "}
                        <span className="text-diff-addition-foreground">+{output.additions}</span>{" "}
                        <span className="text-diff-deletion-foreground">−{output.deletions}</span>
                      </>
                    )}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      output.kind === "file"
                        ? useRightPanelStore
                            .getState()
                            .openFile(scopeThreadRef(thread.environmentId, thread.id), output.path)
                        : openThread(output.threadId)
                    }
                  >
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="flex flex-col gap-1">
          <SectionTitle>Workspace</SectionTitle>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-2 text-xs">
            <dt className="text-muted-foreground">Branch</dt>
            <dd className="truncate font-mono">{thread.branch ?? "None yet"}</dd>
            <dt className="text-muted-foreground">Pull request</dt>
            <dd className="truncate">{pullRequest ? `#${pullRequest.number}` : "None yet"}</dd>
            <dt className="text-muted-foreground">Questions go to</dt>
            <dd className="truncate">
              {supervisor ? `${formatStageName(supervisor)}, then you` : "You"}
            </dd>
            <dt className="text-muted-foreground">On failure</dt>
            <dd>Pause and notify me</dd>
          </dl>
          {snapshot.executionError ? (
            <p role="alert" className="px-2 text-xs break-words text-destructive">
              {snapshot.executionError}
            </p>
          ) : null}
        </section>

        <footer className="flex flex-wrap gap-2 px-1">
          {footer.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === "cancel" ? "destructive-outline" : "outline"}
              disabled={busy}
              title={CREW_ACTION_COPY[action].description}
              onClick={() => void run(action)}
            >
              {CREW_ACTION_COPY[action].label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={props.onEditWorkflow}>
            Edit workflow
          </Button>
        </footer>
      </div>
    </div>
  );
}
