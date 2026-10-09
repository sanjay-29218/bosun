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
  const pause = useAtomCommand(workflowsEnvironment.pause);
  const resume = useAtomCommand(workflowsEnvironment.resume);
  const [answerText, setAnswerText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = snapshot.data;
  const active = data?.steps.find((step) => step.id === data.activeStepId);
  const question = data?.recentEvents.findLast(
    (event) => event.kind === "question" && event.executionId === active?.executionId,
  );
  const task = data?.activeStepId ? data.definition.steps[data.activeStepId] : null;
  const supervisor = task?.type === "task" ? data?.definition.bots[task.bot]?.supervisor : null;
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
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
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
                    : data.paused
                      ? "Paused · current work may finish; the next step will wait"
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
          {data.executionError ? (
            <p role="alert" className="break-words text-sm text-destructive">
              {data.executionError}
            </p>
          ) : null}
          {data.executionConfigured === false && !data.completed && !data.cancelled ? (
            <p className="text-sm text-muted-foreground">
              Waiting for the feature crew to be attached.
            </p>
          ) : null}
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
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <p className="text-sm font-medium">Question from {active.id}</p>
              <p className="text-sm text-muted-foreground">
                {question?.detail ?? "The step needs an answer."}
              </p>
              {supervisor ? (
                <p className="text-xs text-muted-foreground">Supervisor: {supervisor}</p>
              ) : null}
              <Textarea
                maxLength={8000}
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
              {data.paused !== undefined ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void invoke(() =>
                      (data.paused ? resume : pause)({
                        environmentId,
                        input: {
                          projectId,
                          featureId,
                          requestId: `workflow-${data.paused ? "resume" : "pause"}:${randomUUID()}`,
                        },
                      }),
                    )
                  }
                >
                  {data.paused ? "Resume workflow" : "Pause workflow"}
                </Button>
              ) : null}
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
                  {data.executionConfigured ? "Retry step" : "Make step ready to retry"}
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
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <h5 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent history · {data.historyLength} events
            </h5>
            {data.recentEvents
              .slice(-12)
              .toReversed()
              .map((event) => (
                <div
                  key={event.id}
                  aria-label={`Recorded by ${event.actorId}`}
                  className="flex gap-3 text-xs"
                >
                  <span className="w-28 shrink-0 text-muted-foreground">
                    {event.stepId} · {event.kind}
                  </span>
                  <span className="min-w-0 break-words">
                    {event.outcome ? `${event.outcome} · ` : ""}
                    {event.detail ?? event.sourceId ?? ""}
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
    <div className="flex flex-col gap-3 border-t border-border pt-4">
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
