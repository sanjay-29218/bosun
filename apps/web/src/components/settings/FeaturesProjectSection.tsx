import { useNavigate } from "@tanstack/react-router";
import { featureHandoffText } from "@t3tools/client-runtime/state/features";
import type { FeatureArtifact, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { randomUUID } from "../../lib/utils";
import { botsEnvironment } from "../../state/bots";
import { featuresEnvironment } from "../../state/features";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./settingsLayout";

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<{ value: string; label: string }>;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <Select
        value={value}
        items={options}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function FeatureDetail({
  project,
  featureId,
}: {
  readonly project: SidebarProjectGroupMember;
  readonly featureId: string;
}) {
  const environmentId = project.environmentId;
  const input = { projectId: project.id, featureId };
  const target = { environmentId, input };
  const snapshot = useEnvironmentQuery(featuresEnvironment.inspection(target));
  const launchState = useEnvironmentQuery(featuresEnvironment.launchState(target));
  const crew = useEnvironmentQuery(
    botsEnvironment.snapshot({ environmentId, input: { projectId: project.id } }),
  );
  const prepare = useAtomCommand(featuresEnvironment.prepareCheckout);
  const setStatus = useAtomCommand(featuresEnvironment.setStatus);
  const launch = useAtomCommand(featuresEnvironment.launch);
  const record = useAtomCommand(featuresEnvironment.recordArtifact);
  const navigate = useNavigate();
  const [mode, setMode] = useState("worktree");
  const [sourceRunId, setSourceRunId] = useState("");
  const [artifactTitle, setArtifactTitle] = useState("");
  const [artifactUrl, setArtifactUrl] = useState("");
  const [artifactKind, setArtifactKind] = useState<FeatureArtifact["kind"]>("other");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = snapshot.data;
  const act = async (action: () => Promise<{ _tag: string; cause?: unknown }>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result._tag !== "Success")
        setError(
          formatEnvironmentQueryError(
            result.cause as Parameters<typeof formatEnvironmentQueryError>[0],
          ),
        );
      snapshot.refresh();
      launchState.refresh();
    } finally {
      setBusy(false);
    }
  };
  const openThread = (threadId: ThreadId) => {
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  };
  return (
    <div className="grid min-w-0 grid-cols-1 gap-5 border-t border-border pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{data?.feature.title ?? "Feature details"}</h3>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            snapshot.refresh();
            launchState.refresh();
            crew.refresh();
          }}
        >
          Refresh
        </Button>
      </div>
      {snapshot.error || error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {error ?? snapshot.error}
        </p>
      ) : null}
      {!data ? (
        <p className="text-sm text-muted-foreground">
          {snapshot.isPending
            ? "Loading feature…"
            : "Feature details are unavailable. Refresh to retry."}
        </p>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-sm">{data.feature.brief}</p>
          <p className="break-all text-xs text-muted-foreground">
            {featureId} · {data.feature.status} · Owner: {data.feature.ownerId ?? "Unassigned"}
          </p>
          <div className="grid gap-2">
            <h4 className="text-sm font-medium">Checkout</h4>
            {data.checkout ? (
              <>
                <p className="break-all text-sm">{data.checkout.path ?? "Checkout not created"}</p>
                <p className="text-sm text-muted-foreground">
                  {data.checkout.branch ?? "Project workspace"} · {data.checkout.phase}
                </p>
                {data.checkout.lastError ? (
                  <p role="alert" className="break-words text-sm text-destructive">
                    {data.checkout.lastError}
                  </p>
                ) : null}
              </>
            ) : (
              <Choice
                label="Work location"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "worktree", label: "Isolated Git worktree" },
                  { value: "workspace", label: "Project workspace · non-coding work" },
                ]}
              />
            )}
            {data.writerThreadId ? (
              <Button variant="outline" size="sm" onClick={() => openThread(data.writerThreadId!)}>
                Open active writer
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">No active feature writer.</p>
            )}
            {data.feature.status === "open" && data.checkout?.phase !== "ready" ? (
              <div>
                <Button
                  disabled={busy}
                  onClick={() => {
                    void act(() =>
                      prepare({
                        ...target,
                        input: {
                          ...input,
                          mode:
                            data.checkout?.mode ??
                            (mode === "workspace" ? "workspace" : "worktree"),
                        },
                      }),
                    );
                  }}
                >
                  {data.checkout?.phase === "failed"
                    ? "Retry checkout setup"
                    : data.checkout?.phase === "pending"
                      ? "Resume checkout setup"
                      : "Prepare checkout"}
                </Button>
              </div>
            ) : null}
          </div>
          {data.checkout?.setupThreadId ? (
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openThread(data.checkout!.setupThreadId!)}
              >
                Open checkout setup thread
              </Button>
            </div>
          ) : null}
          <div className="grid gap-2">
            <h4 className="text-sm font-medium">Crew</h4>
            {data.bots.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Enable feature templates in Bots to create a specialist crew.
              </p>
            ) : (
              data.bots.map((bot) => (
                <div key={bot.id} className="grid gap-1">
                  <p className="text-sm">
                    {bot.name} · {bot.enabled ? "Enabled" : "Disabled"}
                  </p>
                  <p className="break-all text-xs text-muted-foreground">
                    {bot.id} · Template: {bot.templateId ?? "Project bot"}
                  </p>
                </div>
              ))
            )}
          </div>
          <div className="grid gap-2">
            <h4 className="text-sm font-medium">Runs and handoffs</h4>
            {data.runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No feature runs yet.</p>
            ) : (
              data.runs.map((run) => (
                <div key={run.id} className="grid gap-1 border-b border-border pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm">
                      {data.bots.find((bot) => bot.id === run.botId)?.name ?? run.botId} ·{" "}
                      {run.turnState}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => openThread(run.threadId)}>
                      Open thread
                    </Button>
                  </div>
                  {run.lastError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {run.lastError}
                    </p>
                  ) : null}
                  {data.handoffs
                    .filter((handoff) => handoff.targetRunId === run.id)
                    .map((handoff) => (
                      <p
                        key={handoff.id}
                        className="whitespace-pre-wrap break-words text-sm text-muted-foreground"
                      >
                        {handoff.status} · {featureHandoffText(handoff)}
                      </p>
                    ))}
                </div>
              ))
            )}
          </div>
          {data.feature.workflowId ? (
            <div className="grid gap-2">
              <h4 className="text-sm font-medium">Workflow</h4>
              <p className="break-all text-sm text-muted-foreground">
                {data.feature.workflowId} · {launchState.data?.phase ?? "Not launched"}
              </p>
              {launchState.error || launchState.data?.lastError ? (
                <p role="alert" className="text-sm text-destructive">
                  {launchState.error ?? launchState.data?.lastError}
                </p>
              ) : null}
              <p className="text-sm text-muted-foreground">
                Workflow progress and crew questions appear in the Workflows section below.
              </p>
              {data.feature.status === "open" &&
              launchState.data?.phase !== "attached" &&
              launchState.data?.phase !== "cancelled" ? (
                <>
                  <Choice
                    label="Coordinator run"
                    value={sourceRunId}
                    onChange={setSourceRunId}
                    options={[
                      { value: "", label: "Choose a started coordinator" },
                      ...(crew.data?.runs ?? [])
                        .filter((run) => run.dispatchState === "started")
                        .map((run) => ({
                          value: run.id,
                          label: `${crew.data?.definitions.find((bot) => bot.id === run.botId)?.name ?? run.botId} · ${run.id}`,
                        })),
                    ]}
                  />
                  <div>
                    <Button
                      disabled={busy || !sourceRunId || data.checkout?.phase !== "ready"}
                      onClick={() => {
                        void act(() => launch({ ...target, input: { ...input, sourceRunId } }));
                      }}
                    >
                      Launch feature workflow
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
          <div className="grid gap-3">
            <h4 className="text-sm font-medium">Artifacts and external work</h4>
            {data.artifacts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Link a PR, Linear issue, design, or other result.
              </p>
            ) : (
              data.artifacts.map((artifact) => (
                <div key={artifact.id} className="grid gap-1">
                  <a
                    href={artifact.url}
                    target="_blank"
                    rel="noreferrer"
                    className="break-words text-sm underline underline-offset-4"
                  >
                    {artifact.title}
                  </a>
                  <p className="break-all text-xs text-muted-foreground">
                    {artifact.kind} · {artifact.status} · Actor: {artifact.actorId}
                  </p>
                  {artifact.detail ? (
                    <p className="whitespace-pre-wrap text-sm">{artifact.detail}</p>
                  ) : null}
                </div>
              ))
            )}
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  const result = await record({
                    ...target,
                    input: {
                      ...input,
                      id: randomUUID(),
                      kind: artifactKind,
                      title: artifactTitle,
                      url: artifactUrl,
                      status: "linked",
                    },
                  });
                  if (result._tag === "Success") {
                    setArtifactTitle("");
                    setArtifactUrl("");
                  }
                  return result;
                });
              }}
            >
              <Choice
                label="Link type"
                value={artifactKind}
                onChange={(value) => setArtifactKind(value as FeatureArtifact["kind"])}
                options={[
                  { value: "pull-request", label: "Pull request" },
                  { value: "linear", label: "Linear issue" },
                  { value: "figma", label: "Figma design" },
                  { value: "other", label: "Other artifact" },
                ]}
              />
              <Label htmlFor={`${featureId}-artifact-title`}>Link title</Label>
              <Input
                id={`${featureId}-artifact-title`}
                required
                maxLength={200}
                value={artifactTitle}
                onChange={(event) => setArtifactTitle(event.target.value)}
              />
              <Label htmlFor={`${featureId}-artifact-url`}>HTTPS link</Label>
              <Input
                id={`${featureId}-artifact-url`}
                type="url"
                required
                maxLength={2000}
                value={artifactUrl}
                onChange={(event) => setArtifactUrl(event.target.value)}
              />
              <div>
                <Button type="submit" variant="outline" disabled={busy}>
                  Add artifact link
                </Button>
              </div>
            </form>
          </div>
          <div>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                void act(() =>
                  setStatus({
                    ...target,
                    input: { ...input, status: data.feature.status === "open" ? "closed" : "open" },
                  }),
                );
              }}
            >
              {data.feature.status === "open" ? "Close feature" : "Reopen feature"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function FeaturesProjectSection({
  project,
  onSelect,
}: {
  readonly onSelect?: (featureId: string) => void;
  readonly project: SidebarProjectGroupMember;
}) {
  const environmentId = project.environmentId;
  const projectId = project.id;
  const list = useEnvironmentQuery(
    featuresEnvironment.list({ environmentId, input: { projectId } }),
  );
  const workflows = useEnvironmentQuery(
    workflowsEnvironment.definitions({ environmentId, input: { projectId } }),
  );
  const create = useAtomCommand(featuresEnvironment.create);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsSection title={`Features · ${project.environmentLabel ?? "This environment"}`}>
      <div className="grid min-w-0 grid-cols-1 gap-5 p-4">
        <p className="break-all text-xs text-muted-foreground">{project.workspaceRoot}</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Track an objective, its specialist crew, and the checkout they use.
          </p>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                list.refresh();
                workflows.refresh();
              }}
            >
              Refresh features
            </Button>
            <Button size="sm" onClick={() => setShowForm(!showForm)}>
              {showForm ? "Cancel new feature" : "New feature"}
            </Button>
          </div>
        </div>
        {list.error || error ? (
          <p role="alert" className="text-sm text-destructive">
            {error ?? list.error}
          </p>
        ) : null}
        {showForm ? (
          <form
            className="grid gap-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError(null);
              try {
                const id = `feature:${randomUUID()}`;
                const result = await create({
                  environmentId,
                  input: { id, projectId, title, brief, ...(workflowId ? { workflowId } : {}) },
                });
                if (result._tag === "Success") {
                  setSelected(id);
                  onSelect?.(id);
                  setTitle("");
                  setBrief("");
                  setShowForm(false);
                } else setError(formatEnvironmentQueryError(result.cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Label htmlFor={`${projectId}-feature-title`}>Feature title</Label>
            <Input
              id={`${projectId}-feature-title`}
              required
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Label htmlFor={`${projectId}-feature-brief`}>Objective and acceptance criteria</Label>
            <Textarea
              id={`${projectId}-feature-brief`}
              required
              maxLength={16000}
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
            />
            <Choice
              label="Workflow"
              value={workflowId}
              onChange={setWorkflowId}
              options={[
                { value: "", label: "No workflow" },
                ...(workflows.data ?? []).map((definition) => ({
                  value: definition.id,
                  label: definition.name,
                })),
              ]}
            />
            {workflows.error ? (
              <p role="alert" className="text-sm text-destructive">
                {workflows.error}
              </p>
            ) : null}
            <div>
              <Button type="submit" disabled={busy}>
                {busy ? "Creating feature…" : "Create feature"}
              </Button>
            </div>
          </form>
        ) : null}
        {list.isPending && !list.data ? (
          <p className="text-sm text-muted-foreground">Loading features…</p>
        ) : null}
        {list.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No features yet. Create one to define the objective and copy its crew.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {list.data?.map((feature) => (
            <Button
              key={feature.id}
              className="max-w-full"
              aria-pressed={selected === feature.id}
              title={`${feature.title} · ${feature.status}`}
              variant={selected === feature.id ? "secondary" : "outline"}
              onClick={() => {
                setSelected(feature.id);
                onSelect?.(feature.id);
              }}
            >
              <span className="min-w-0 truncate">
                {feature.title} · {feature.status}
              </span>
            </Button>
          ))}
        </div>
        {selected ? <FeatureDetail key={selected} project={project} featureId={selected} /> : null}
      </div>
    </SettingsSection>
  );
}
