import { formatStageName } from "@t3tools/client-runtime/crew-stage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { memo } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { workflowsEnvironment } from "../../state/workflows";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";

/**
 * What a stage thread started from: earlier outputs, gate notes, and the branch it runs on.
 * Nothing else passes between stages, so a wrong handoff is visible here.
 */
export const CrewHandoffCard = memo(function CrewHandoffCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const handoff = useEnvironmentQuery(
    workflowsEnvironment.stageHandoff({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, threadId: props.threadId },
    }),
  ).data;
  const navigate = useNavigate();
  if (!handoff) return null;
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  const commit = handoff.workspace.commit?.slice(0, 7);
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane pt-2 sm:pt-3">
        <section
          aria-label="Stage handoff"
          className="flex flex-col gap-2 rounded-xl border border-border px-3 py-2.5 text-xs text-muted-foreground"
        >
          <header className="text-sm">
            <span className="font-medium text-foreground">
              Handoff to {formatStageName(handoff.stepId)}
            </span>
            {handoff.from ? ` · from ${formatStageName(handoff.from.stepId)}` : null}
            {handoff.attempt > 1 ? ` · attempt ${handoff.attempt}` : null}
            {` · ${formatRelativeTimeLabel(handoff.createdAt)}`}
          </header>
          {handoff.outputs.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {handoff.outputs.map((output) => (
                <li
                  key={output.kind === "file" ? `file:${output.path}` : `diff:${output.stepId}`}
                  className="flex min-w-0 items-center gap-2"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {output.kind === "file" ? (
                      <>
                        <span className="font-mono text-foreground">{output.path}</span> v
                        {output.version} · {formatStageName(output.stepId)}
                        {output.exists === false ? " · missing from the worktree" : null}
                      </>
                    ) : (
                      <>
                        {formatStageName(output.stepId)} diff{" "}
                        <span className="text-diff-addition-foreground">+{output.additions}</span>{" "}
                        <span className="text-diff-deletion-foreground">−{output.deletions}</span>
                      </>
                    )}
                  </span>
                  {output.threadId ? (
                    <Button size="xs" variant="ghost" onClick={() => openThread(output.threadId!)}>
                      Open
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {handoff.notes.map((note) => (
            <p key={`${note.stepId}:${note.occurredAt}`} className="line-clamp-3">
              <span className="text-foreground">
                {note.kind === "decision"
                  ? "Your note"
                  : `${formatStageName(note.stepId)}${note.outcome ? ` → ${formatStageName(note.outcome)}` : ""}`}
              </span>{" "}
              “{note.text}”
            </p>
          ))}
          {handoff.retry ? (
            <p className="line-clamp-2">
              <span className="text-foreground">Previous attempt failed</span>{" "}
              {handoff.retry.previousError}
            </p>
          ) : null}
          {handoff.workspace.branch || handoff.scope ? (
            <p className="font-mono">
              {handoff.workspace.branch ?? ""}
              {commit ? ` @ ${commit}` : ""}
              {handoff.scope ? ` · scope ${handoff.scope}` : ""}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
});
