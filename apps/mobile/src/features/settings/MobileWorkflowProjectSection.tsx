import { useNavigation } from "@react-navigation/native";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { SettingsSection } from "./components/SettingsSection";

export function MobileWorkflowProjectSection(props: {
  readonly project: EnvironmentProject;
  readonly environmentLabel: string;
}) {
  const navigation = useNavigation();
  const { project } = props;
  const [featureId, setFeatureId] = useState("");
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const definitions = useEnvironmentQuery(
    workflowsEnvironment.definitions({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const snapshot = useEnvironmentQuery(
    selectedFeatureId
      ? workflowsEnvironment.feature({
          environmentId: project.environmentId,
          input: { projectId: project.id, featureId: selectedFeatureId },
        })
      : null,
  );
  const answer = useAtomCommand(workflowsEnvironment.answer);
  const retry = useAtomCommand(workflowsEnvironment.retry);
  const cancel = useAtomCommand(workflowsEnvironment.cancel);
  const pause = useAtomCommand(workflowsEnvironment.pause);
  const resume = useAtomCommand(workflowsEnvironment.resume);
  const data = snapshot.data;
  const active = data?.steps.find((step) => step.id === data.activeStepId);
  const question = data?.recentEvents.findLast(
    (event) => event.kind === "question" && event.executionId === active?.executionId,
  );
  const act = async (command: "answer" | "retry" | "cancel" | "pause" | "resume") => {
    if (!selectedFeatureId || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const input = {
        projectId: project.id,
        featureId: selectedFeatureId,
        requestId: `workflow-${command}:${uuidv4()}`,
      };
      const target = { environmentId: project.environmentId, input };
      const result =
        command === "answer"
          ? await answer({ ...target, input: { ...input, text: answerText.trim() } })
          : command === "retry"
            ? await retry(target)
            : command === "pause"
              ? await pause(target)
              : command === "resume"
                ? await resume(target)
                : await cancel(target);
      if (result._tag === "Success") {
        if (command === "answer") setAnswerText("");
        snapshot.refresh();
      } else {
        setActionError(formatEnvironmentQueryError(result.cause));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={`Workflows · ${props.environmentLabel}`}>
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground-muted">
          {definitions.data?.length ?? 0} reusable definitions in this checkout.
        </Text>
        {definitions.error ? (
          <Text className="text-sm text-red-500">{definitions.error}</Text>
        ) : null}
        {definitions.data?.map((definition) => (
          <Text key={definition.id} className="text-sm text-foreground">
            {definition.name} · revision {definition.revision}
          </Text>
        ))}
        <View className="flex-row items-center gap-2">
          <AppTextInput
            accessibilityLabel={`Feature ID on ${props.environmentLabel}`}
            placeholder="Feature ID"
            value={featureId}
            onChangeText={setFeatureId}
            className="min-h-11 min-w-0 flex-1 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Inspect feature workflow"
            disabled={!featureId.trim()}
            onPress={() => setSelectedFeatureId(featureId.trim())}
            className="rounded-full bg-subtle-strong px-4 py-2 disabled:opacity-40"
          >
            <Text className="text-sm font-t3-medium text-foreground">Inspect</Text>
          </Pressable>
        </View>
        {selectedFeatureId && snapshot.isPending && !data ? (
          <Text className="text-sm text-foreground-muted">Loading workflow progress…</Text>
        ) : null}
        {snapshot.error ? <Text className="text-sm text-red-500">{snapshot.error}</Text> : null}
        {actionError ? <Text className="text-sm text-red-500">{actionError}</Text> : null}
        {selectedFeatureId && !snapshot.isPending && !data && !snapshot.error ? (
          <Text className="text-sm text-foreground-muted">No workflow copy found.</Text>
        ) : null}
        {data ? (
          <View className="gap-3 border-t border-border-subtle pt-3">
            <Text className="text-sm font-t3-medium text-foreground">
              {data.definition.name} · revision {data.definition.revision}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {data.completed
                ? "Completed"
                : data.cancelled
                  ? "Cancelled"
                  : data.paused
                    ? "Paused · the next step will wait"
                    : active
                      ? `${active.id} · ${active.status}`
                      : "Ready to start"}
            </Text>
            {data.executionError ? (
              <Text accessibilityRole="alert" className="text-sm text-red-500">
                {data.executionError}
              </Text>
            ) : null}
            {data.executionConfigured === false && !data.completed && !data.cancelled ? (
              <Text className="text-sm text-foreground-muted">
                Waiting for the feature crew to be attached.
              </Text>
            ) : null}
            {data.steps.map((step) => {
              return (
                <View key={step.id} className="gap-1 rounded-xl border border-border-subtle p-3">
                  <Text className="text-sm font-t3-medium text-foreground">
                    {step.id} · {step.status}
                  </Text>
                  {step.attempt > 0 ? (
                    <Text className="text-xs text-foreground-muted">Attempt {step.attempt}</Text>
                  ) : null}
                  {step.threadId ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${step.id} thread`}
                      onPress={() =>
                        navigation.navigate("Thread", {
                          environmentId: String(project.environmentId),
                          threadId: step.threadId!,
                        })
                      }
                    >
                      <Text className="text-sm text-foreground">Open bot thread</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
            {active?.status === "needs-input" ? (
              <View className="gap-2 rounded-xl border border-border-subtle p-3">
                <Text className="text-sm font-t3-medium text-foreground">
                  Question for {active.id}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {question?.detail ?? "This step needs an answer."}
                </Text>
                <AppTextInput
                  accessibilityLabel="Workflow answer"
                  multiline
                  value={answerText}
                  onChangeText={setAnswerText}
                  maxLength={8000}
                  className="min-h-16 rounded-xl border-continuous bg-card px-3 py-2 text-base text-foreground"
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={!answerText.trim() || busy}
                  onPress={() => void act("answer")}
                  className="self-start disabled:opacity-40"
                >
                  <Text className="text-sm font-t3-medium text-foreground">Send answer</Text>
                </Pressable>
              </View>
            ) : null}
            {!data.completed && !data.cancelled ? (
              <View className="flex-row flex-wrap gap-4">
                {data.paused !== undefined ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void act(data.paused ? "resume" : "pause")}
                  >
                    <Text className="text-sm text-foreground">
                      {data.paused ? "Resume workflow" : "Pause workflow"}
                    </Text>
                  </Pressable>
                ) : null}
                {active?.status === "failed" ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void act("retry")}
                  >
                    <Text className="text-sm text-foreground">
                      {data.executionConfigured ? "Retry step" : "Make step ready to retry"}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void act("cancel")}
                >
                  <Text className="text-sm text-foreground-muted">Cancel workflow</Text>
                </Pressable>
              </View>
            ) : null}
            <Text className="text-xs text-foreground-muted">
              {data.historyLength} recorded events
            </Text>
            {data.recentEvents.slice(-8).map((event) => (
              <Text key={event.id} className="text-xs text-foreground-muted">
                {event.stepId} · {event.kind} · {event.detail ?? event.outcome ?? ""}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}
