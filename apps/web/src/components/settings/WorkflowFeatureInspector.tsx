import { useNavigate } from "@tanstack/react-router";
import { type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

function FeatureRun({
  environmentId,
  projectId,
  featureId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly featureId: string;
}) {
  const navigate = useNavigate();
  const snapshot = useEnvironmentQuery(
    workflowsEnvironment.feature({
      environmentId,
      input: { projectId, featureId },
    }),
  );
  const answer = useAtomCommand(workflowsEnvironment.answer);
  const retry = useAtomCommand(workflowsEnvironment.retry);
  const cancel = useAtomCommand(workflowsEnvironment.cancel);
  const [answerText, setAnswerText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = snapshot.data;
  const active = data?.steps.find((step) => step.id === data.activeStepId);
  const last = data?.recentEvents.at(-1);
  const invoke = async (
    action: () => Promise<{ readonly _tag: string; readonly cause?: unknown }>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result._tag !== "Success")
        setError(formatEnvironmentQueryError(result.cause as Cause.Cause<unknown>));
      else snapshot.refresh();
      return result._tag === "Success";
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      {snapshot.error ? (
        <p role="alert" className="text-sm text-destructive">
          {snapshot.error}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!data ? (
        <p className="text-sm text-muted-foreground">
          {snapshot.error
            ? "Workflow progress is unavailable."
            : snapshot.isPending
              ? "Loading workflow progress…"
              : "No workflow copy found for this feature."}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 className="text-sm font-medium">
                {data.definition.name} · revision {data.definition.revision}
              </h4>
              <p className="text-xs text-muted-foreground">
                {data.completed
                  ? "Completed"
                  : data.cancelled
                    ? "Cancelled"
                    : active
                      ? `${active.id} · ${active.status === "pending" && active.attempt > 0 ? "ready for another run" : active.status}`
                      : "Ready to start"}
                {active?.botRunId ? ` · run ${active.botRunId}` : ""}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => snapshot.refresh()}>
              Refresh
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.steps.map((step) => (
              <div
                key={step.id}
                className={`rounded-md border p-3 ${step.id === data.activeStepId ? "border-primary/50 bg-primary/5" : "border-border"}`}
              >
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium">{step.id}</span>
                  <span className="text-muted-foreground">{step.status}</span>
                </div>
                {step.attempt > 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Attempt {step.attempt}
                    {step.outcome ? ` · ${step.outcome}` : ""}
                  </p>
                ) : null}
                {step.threadId ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: { environmentId, threadId: step.threadId! },
                      });
                    }}
                  >
                    Open bot thread
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
          {active?.status === "needs-input" ? (
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-sm font-medium">Question from {active.id}</p>
              <p className="text-sm text-muted-foreground">
                {last?.kind === "question" ? last.detail : "The step needs an answer."}
              </p>
              <Textarea
                aria-label="Workflow answer"
                value={answerText}
                rows={3}
                onChange={(event) => setAnswerText(event.target.value)}
              />
              <Button
                size="sm"
                disabled={busy || !answerText.trim()}
                onClick={() =>
                  void invoke(() =>
                    answer({
                      environmentId,
                      input: {
                        projectId,
                        featureId,
                        requestId: `workflow-answer:${randomUUID()}`,
                        text: answerText.trim(),
                      },
                    }),
                  ).then((okay) => {
                    if (okay) setAnswerText("");
                  })
                }
              >
                Send answer
              </Button>
            </div>
          ) : null}
          {!data.completed && !data.cancelled ? (
            <div className="flex flex-wrap gap-2">
              {active?.status === "failed" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void invoke(() =>
                      retry({
                        environmentId,
                        input: {
                          projectId,
                          featureId,
                          requestId: `workflow-retry:${randomUUID()}`,
                        },
                      }),
                    )
                  }
                >
                  Make step ready to retry
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void invoke(() =>
                    cancel({
                      environmentId,
                      input: { projectId, featureId, requestId: `workflow-cancel:${randomUUID()}` },
                    }),
                  )
                }
              >
                Cancel workflow
              </Button>
            </div>
          ) : null}
          <div className="space-y-2 border-t border-border pt-3">
            <h5 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent history · {data.historyLength} events
            </h5>
            {data.recentEvents
              .slice(-12)
              .toReversed()
              .map((event) => (
                <div key={event.id} className="flex gap-3 text-xs">
                  <span className="w-28 shrink-0 text-muted-foreground">
                    {event.stepId} · {event.kind}
                  </span>
                  <span className="min-w-0 break-words">
                    {event.outcome ?? event.detail ?? event.sourceId ?? ""}
                  </span>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

export function WorkflowFeatureInspector(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const [featureId, setFeatureId] = useState("");
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div>
        <h4 className="text-sm font-medium">Feature progress</h4>
        <p className="text-xs text-muted-foreground">
          Inspect the copied workflow and its recorded step history.
        </p>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setInspectedId(featureId.trim() || null);
        }}
      >
        <Input
          aria-label="Feature ID to inspect"
          placeholder="Feature ID"
          value={featureId}
          onChange={(event) => setFeatureId(event.target.value)}
          className="max-w-64"
        />
        <Button size="sm" variant="outline" type="submit" disabled={!featureId.trim()}>
          Inspect workflow
        </Button>
      </form>
      {inspectedId ? (
        <FeatureRun
          key={inspectedId}
          environmentId={props.environmentId}
          projectId={props.projectId}
          featureId={inspectedId}
        />
      ) : null}
    </div>
  );
}
