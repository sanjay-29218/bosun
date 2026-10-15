import { useNavigation } from "@react-navigation/native";
import { featureHandoffText } from "@t3tools/client-runtime/state/features";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { FeatureArtifact, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { botsEnvironment } from "../../state/bots";
import { featuresEnvironment } from "../../state/features";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { SettingsSection } from "./components/SettingsSection";

function Action({
  label,
  disabled = false,
  onPress,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 justify-center rounded-xl bg-subtle-strong px-4 py-2 disabled:opacity-40"
    >
      <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
    </Pressable>
  );
}

function Detail({
  project,
  featureId,
}: {
  readonly project: EnvironmentProject;
  readonly featureId: string;
}) {
  const navigation = useNavigation();
  const target = {
    environmentId: project.environmentId,
    input: { projectId: project.id, featureId },
  };
  const snapshot = useEnvironmentQuery(featuresEnvironment.inspection(target));
  const launchState = useEnvironmentQuery(featuresEnvironment.launchState(target));
  const crew = useEnvironmentQuery(
    botsEnvironment.snapshot({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const prepare = useAtomCommand(featuresEnvironment.prepareCheckout);
  const status = useAtomCommand(featuresEnvironment.setStatus);
  const launch = useAtomCommand(featuresEnvironment.launch);
  const artifact = useAtomCommand(featuresEnvironment.recordArtifact);
  const [mode, setMode] = useState<"worktree" | "workspace">("worktree");
  const [sourceRunId, setSourceRunId] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<FeatureArtifact["kind"]>("other");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const openThread = (threadId: ThreadId) =>
    navigation.navigate("Thread", { environmentId: String(project.environmentId), threadId });
  const data = snapshot.data;
  return (
    <View className="gap-3 border-t border-border-subtle pt-4">
      <Action
        label="Refresh feature details"
        onPress={() => {
          snapshot.refresh();
          launchState.refresh();
          crew.refresh();
        }}
      />
      {error || snapshot.error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-500">
          {error ?? snapshot.error}
        </Text>
      ) : null}
      {!data ? (
        <Text className="text-sm text-foreground-muted">
          {snapshot.isPending
            ? "Loading feature…"
            : "Feature details are unavailable. Refresh to retry."}
        </Text>
      ) : (
        <>
          <Text className="text-base font-t3-medium text-foreground">
            {data.feature.title} · {data.feature.status}
          </Text>
          <Text selectable className="text-sm text-foreground">
            {data.feature.brief}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            {featureId} · Owner: {data.feature.ownerId ?? "Unassigned"}
          </Text>
          <Text className="text-sm font-t3-medium text-foreground">Checkout</Text>
          {data.checkout ? (
            <>
              <Text selectable className="text-sm text-foreground">
                {data.checkout.path ?? "Checkout not created"}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {data.checkout.branch ?? "Project workspace"} · {data.checkout.phase}
              </Text>
              {data.checkout.lastError ? (
                <Text accessibilityRole="alert" className="text-sm text-red-500">
                  {data.checkout.lastError}
                </Text>
              ) : null}
            </>
          ) : (
            <>
              <Action
                label={`${mode === "worktree" ? "Selected: " : ""}Isolated Git worktree`}
                onPress={() => setMode("worktree")}
              />
              <Action
                label={`${mode === "workspace" ? "Selected: " : ""}Project workspace · non-coding work`}
                onPress={() => setMode("workspace")}
              />
            </>
          )}
          {data.writerThreadId ? (
            <Action label="Open active writer" onPress={() => openThread(data.writerThreadId!)} />
          ) : (
            <Text className="text-sm text-foreground-muted">No active feature writer.</Text>
          )}
          {data.feature.status === "open" && data.checkout?.phase !== "ready" ? (
            <Action
              label={
                data.checkout?.phase === "failed"
                  ? "Retry checkout setup"
                  : data.checkout?.phase === "pending"
                    ? "Resume checkout setup"
                    : "Prepare checkout"
              }
              disabled={busy}
              onPress={() => {
                void act(() =>
                  prepare({
                    ...target,
                    input: { ...target.input, mode: data.checkout?.mode ?? mode },
                  }),
                );
              }}
            />
          ) : null}
          {data.checkout?.setupThreadId ? (
            <Action
              label="Open checkout setup thread"
              onPress={() => openThread(data.checkout!.setupThreadId!)}
            />
          ) : null}
          <Text className="text-sm font-t3-medium text-foreground">Crew</Text>
          {data.bots.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              Enable feature templates in Bots to create a specialist crew.
            </Text>
          ) : (
            data.bots.map((bot) => (
              <View key={bot.id} className="gap-1">
                <Text className="text-sm text-foreground">
                  {bot.name} · {bot.enabled ? "Enabled" : "Disabled"}
                </Text>
                <Text selectable className="text-xs text-foreground-muted">
                  {bot.id} · Template: {bot.templateId ?? "Project bot"}
                </Text>
              </View>
            ))
          )}
          <Text className="text-sm font-t3-medium text-foreground">Runs and handoffs</Text>
          {data.runs.length === 0 ? (
            <Text className="text-sm text-foreground-muted">No feature runs yet.</Text>
          ) : (
            data.runs.map((run) => (
              <View key={run.id} className="gap-2">
                <Text className="text-sm text-foreground">
                  {data.bots.find((bot) => bot.id === run.botId)?.name ?? run.botId} ·{" "}
                  {run.turnState}
                </Text>
                {run.lastError ? (
                  <Text accessibilityRole="alert" className="text-sm text-red-500">
                    {run.lastError}
                  </Text>
                ) : null}
                {data.handoffs
                  .filter((request) => request.targetRunId === run.id)
                  .map((request) => (
                    <Text key={request.id} className="text-sm text-foreground-muted">
                      {request.status} · {featureHandoffText(request)}
                    </Text>
                  ))}
                <Action
                  label={`Open thread for ${run.botId}`}
                  onPress={() => openThread(run.threadId)}
                />
              </View>
            ))
          )}
          {data.feature.workflowId ? (
            <View className="gap-2">
              <Text className="text-sm font-t3-medium text-foreground">
                Workflow · {launchState.data?.phase ?? "Not launched"}
              </Text>
              <Text className="text-sm text-foreground-muted">
                Workflow progress and crew questions appear in the Workflows section below.
              </Text>
              {launchState.error || launchState.data?.lastError ? (
                <Text accessibilityRole="alert" className="text-sm text-red-500">
                  {launchState.error ?? launchState.data?.lastError}
                </Text>
              ) : null}
              {data.feature.status === "open" &&
              launchState.data?.phase !== "attached" &&
              launchState.data?.phase !== "cancelled" ? (
                <>
                  <Text className="text-sm text-foreground">Choose a started coordinator</Text>
                  {crew.data?.runs
                    .filter((run) => run.dispatchState === "started")
                    .map((run) => (
                      <Action
                        key={run.id}
                        label={`${sourceRunId === run.id ? "Selected: " : ""}${crew.data?.definitions.find((bot) => bot.id === run.botId)?.name ?? run.botId} · ${run.id}`}
                        onPress={() => setSourceRunId(run.id)}
                      />
                    ))}
                  <Action
                    label="Launch feature workflow"
                    disabled={busy || !sourceRunId || data.checkout?.phase !== "ready"}
                    onPress={() => {
                      void act(() =>
                        launch({ ...target, input: { ...target.input, sourceRunId } }),
                      );
                    }}
                  />
                </>
              ) : null}
            </View>
          ) : null}
          <Text className="text-sm font-t3-medium text-foreground">
            Artifacts and external work
          </Text>
          {data.artifacts.length === 0 ? (
            <Text className="text-sm text-foreground-muted">No artifact links yet.</Text>
          ) : (
            data.artifacts.map((link) => (
              <View key={link.id} className="gap-1">
                <Action
                  label={link.title}
                  onPress={() => {
                    void Linking.openURL(link.url).catch(() =>
                      setError("The artifact link could not be opened."),
                    );
                  }}
                />
                <Text selectable className="text-xs text-foreground-muted">
                  {link.kind} · {link.status} · Actor: {link.actorId}
                </Text>
                {link.detail ? (
                  <Text className="text-sm text-foreground">{link.detail}</Text>
                ) : null}
              </View>
            ))
          )}
          <Text className="text-sm text-foreground">Link type</Text>
          <View className="flex-row flex-wrap gap-2">
            {(["pull-request", "linear", "figma", "other"] as const).map((option) => (
              <Action
                key={option}
                label={`${kind === option ? "Selected: " : ""}${option}`}
                onPress={() => setKind(option)}
              />
            ))}
          </View>
          <Text className="text-sm text-foreground">Link title</Text>
          <AppTextInput
            accessibilityLabel="Artifact title"
            value={title}
            onChangeText={setTitle}
            maxLength={200}
            className="min-h-11 rounded-xl bg-card px-3 text-base text-foreground"
          />
          <Text className="text-sm text-foreground">HTTPS link</Text>
          <AppTextInput
            accessibilityLabel="Artifact HTTPS link"
            value={url}
            onChangeText={setUrl}
            maxLength={2000}
            autoCapitalize="none"
            keyboardType="url"
            className="min-h-11 rounded-xl bg-card px-3 text-base text-foreground"
          />
          <Action
            label="Add artifact link"
            disabled={busy || !title.trim() || !url.trim()}
            onPress={() => {
              void act(async () => {
                const result = await artifact({
                  ...target,
                  input: { ...target.input, id: uuidv4(), kind, title, url, status: "linked" },
                });
                if (result._tag === "Success") {
                  setTitle("");
                  setUrl("");
                }
                return result;
              });
            }}
          />
          <Action
            label={data.feature.status === "open" ? "Close feature" : "Reopen feature"}
            disabled={busy}
            onPress={() => {
              void act(() =>
                status({
                  ...target,
                  input: {
                    ...target.input,
                    status: data.feature.status === "open" ? "closed" : "open",
                  },
                }),
              );
            }}
          />
        </>
      )}
    </View>
  );
}

export function MobileFeaturesProjectSection({
  project,
  environmentLabel,
  onSelect,
}: {
  readonly project: EnvironmentProject;
  readonly environmentLabel: string;
  readonly onSelect?: (featureId: string) => void;
}) {
  const target = { environmentId: project.environmentId, input: { projectId: project.id } };
  const list = useEnvironmentQuery(featuresEnvironment.list(target));
  const definitions = useEnvironmentQuery(workflowsEnvironment.definitions(target));
  const create = useAtomCommand(featuresEnvironment.create);
  const [selected, setSelected] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsSection title={`Features · ${environmentLabel}`}>
      <View className="gap-3 p-4">
        <Text selectable className="text-xs text-foreground-muted">
          {project.workspaceRoot}
        </Text>
        <Text className="text-sm text-foreground-muted">
          Track an objective, its specialist crew, and the checkout they use.
        </Text>
        <Action
          label="Refresh features"
          onPress={() => {
            list.refresh();
            definitions.refresh();
          }}
        />
        <Action
          label={showForm ? "Cancel new feature" : "New feature"}
          onPress={() => setShowForm(!showForm)}
        />
        {list.error || error ? (
          <Text accessibilityRole="alert" className="text-sm text-red-500">
            {error ?? list.error}
          </Text>
        ) : null}
        {showForm ? (
          <View className="gap-3">
            <Text className="text-sm text-foreground">Feature title</Text>
            <AppTextInput
              accessibilityLabel="Feature title"
              value={title}
              onChangeText={setTitle}
              maxLength={200}
              className="min-h-11 rounded-xl bg-card px-3 text-base text-foreground"
            />
            <Text className="text-sm text-foreground">Objective and acceptance criteria</Text>
            <AppTextInput
              accessibilityLabel="Feature objective and acceptance criteria"
              value={brief}
              onChangeText={setBrief}
              maxLength={16000}
              multiline
              className="min-h-24 rounded-xl bg-card px-3 py-3 text-base text-foreground"
            />
            <Text className="text-sm text-foreground">Workflow</Text>
            <Action
              label={`${workflowId === "" ? "Selected: " : ""}No workflow`}
              onPress={() => setWorkflowId("")}
            />
            {definitions.data?.map((definition) => (
              <Action
                key={definition.id}
                label={`${workflowId === definition.id ? "Selected: " : ""}${definition.name}`}
                onPress={() => setWorkflowId(definition.id)}
              />
            ))}
            {definitions.error ? (
              <Text accessibilityRole="alert" className="text-sm text-red-500">
                {definitions.error}
              </Text>
            ) : null}
            <Action
              label={busy ? "Creating feature…" : "Create feature"}
              disabled={busy || !title.trim() || !brief.trim()}
              onPress={() => {
                void (async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const id = `feature:${uuidv4()}`;
                    const result = await create({
                      ...target,
                      input: {
                        ...target.input,
                        id,
                        title,
                        brief,
                        ...(workflowId ? { workflowId } : {}),
                      },
                    });
                    if (result._tag === "Success") {
                      setSelected(id);
                      onSelect?.(id);
                      setShowForm(false);
                      setTitle("");
                      setBrief("");
                    } else setError(formatEnvironmentQueryError(result.cause));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            />
          </View>
        ) : null}
        {list.isPending && !list.data ? (
          <Text className="text-sm text-foreground-muted">Loading features…</Text>
        ) : null}
        {list.data?.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            No features yet. Create one to define the objective and copy its crew.
          </Text>
        ) : null}
        {list.data?.map((feature) => (
          <Action
            key={feature.id}
            label={`${selected === feature.id ? "Selected: " : ""}${feature.title} · ${feature.status}`}
            onPress={() => {
              setSelected(feature.id);
              onSelect?.(feature.id);
            }}
          />
        ))}
        {selected ? <Detail key={selected} project={project} featureId={selected} /> : null}
      </View>
    </SettingsSection>
  );
}
