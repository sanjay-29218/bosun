import { makeFeatureDraft } from "@t3tools/client-runtime/state/featureThreads";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { rolesEnvironment } from "../../state/roles";
import { useThreadShell } from "../../state/entities";
import { featureThreadsEnvironment } from "../../state/featureThreads";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";

type FeatureThreadTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

const failureMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/**
 * A thread's place in Crew, opened from its row menu: Make it a feature for a plain thread,
 * Detach from workflow for a feature's current stage thread.
 */
export function FeatureThreadSheet({ route }: StaticScreenProps<FeatureThreadTarget>) {
  const { environmentId, threadId } = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const link = useEnvironmentQuery(
    thread
      ? featureThreadsEnvironment.link({
          environmentId,
          input: { projectId: thread.projectId, threadId },
        })
      : null,
  );
  const detach = useAtomCommand(featureThreadsEnvironment.detach, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);

  const confirmDetach = () => {
    if (!thread) return;
    Alert.alert(
      "Detach from workflow?",
      "The thread carries on as a plain thread and the rest of the feature is cancelled. Reopen the feature to reattach it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Detach",
          style: "destructive",
          onPress: () => {
            void detach({
              environmentId,
              input: { projectId: thread.projectId, threadId, requestId: uuidv4() },
            }).then((result) => {
              if (result._tag === "Success") navigation.goBack();
              else setError(failureMessage(squashAtomCommandFailure(result), "Could not detach."));
            });
          },
        },
      ],
    );
  };

  const stage = link.data?.stage ?? null;
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-4 px-5 pt-6"
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      keyboardShouldPersistTaps="handled"
    >
      {!thread || link.isPending || (!link.data && !link.error) ? (
        <Text className="text-sm text-foreground-muted">Loading…</Text>
      ) : link.error ? (
        <Text className="text-sm text-red-500">{link.error}</Text>
      ) : stage?.current && link.data?.attachable ? (
        <View className="gap-3">
          <Text className="text-lg font-t3-medium text-foreground">Detach from workflow</Text>
          <Text className="text-sm text-foreground-muted">
            This thread is stage {stage.index} of {stage.total} of a feature. Detaching makes it a
            plain thread and cancels the rest of the feature.
          </Text>
          <Pressable
            accessibilityRole="button"
            className="items-center rounded-full bg-subtle-strong px-4 py-3"
            onPress={confirmDetach}
          >
            <Text className="text-base font-t3-medium text-red-500">Detach from workflow</Text>
          </Pressable>
        </View>
      ) : link.data?.attachable ? (
        <MakeFeatureForm
          environmentId={environmentId}
          threadId={threadId}
          projectId={thread.projectId}
          initialTitle={thread.title}
          onDone={() => navigation.goBack()}
        />
      ) : (
        <Text className="text-sm text-foreground-muted">
          Crew threads belong to the crew and can't become features.
        </Text>
      )}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-500">
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function MakeFeatureForm(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: NonNullable<ReturnType<typeof useThreadShell>>["projectId"];
  readonly initialTitle: string;
  readonly onDone: () => void;
}) {
  const library = { environmentId: props.environmentId, input: {} };
  const definitions = useEnvironmentQuery(workflowsEnvironment.definitions(library));
  const roleConfigs = useEnvironmentQuery(rolesEnvironment.roles(library));
  const attach = useAtomCommand(featureThreadsEnvironment.attach, { reportFailure: false });
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [stageId, setStageId] = useState<string | null>(null);
  const [title, setTitle] = useState(props.initialTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One feature ID per sheet, so a retried submit returns the same feature.
  const [featureId] = useState(() => `feature:${uuidv4()}`);
  const workflows = definitions.data ?? [];
  const workflow = workflows.find((item) => item.id === workflowId) ?? workflows[0] ?? null;
  const roles = useMemo(
    () =>
      new Map(
        (roleConfigs.data ?? []).map((role) => [
          role.id,
          { name: role.name, model: role.modelSelection.model },
        ]),
      ),
    [roleConfigs.data],
  );
  const draft = workflow
    ? makeFeatureDraft(workflow, stageId ?? workflow.start, roles)
    : { stages: [], stage: null, next: null };
  const stage = draft.stage ?? draft.stages[0] ?? null;

  const submit = async () => {
    if (!workflow || !stage || !title.trim()) return;
    setBusy(true);
    setError(null);
    const result = await attach({
      environmentId: props.environmentId,
      input: {
        featureId,
        projectId: props.projectId,
        threadId: props.threadId,
        workflowId: workflow.id,
        stageId: stage.stepId,
        title: title.trim(),
      },
    });
    setBusy(false);
    if (result._tag === "Success") props.onDone();
    else setError(failureMessage(squashAtomCommandFailure(result), "Could not make the feature."));
  };

  if (workflows.length === 0) {
    return (
      <Text className="text-sm text-foreground-muted">
        {definitions.isPending
          ? "Loading workflows…"
          : (definitions.error ?? "No workflows yet. Add one in the project's Workflows settings.")}
      </Text>
    );
  }
  return (
    <View className="gap-4">
      <View className="gap-1">
        <Text className="text-lg font-t3-medium text-foreground">Make it a feature</Text>
        <Text className="text-sm text-foreground-muted">
          This thread becomes the stage you pick. Earlier stages are marked skipped.
        </Text>
      </View>
      <Choices
        label="Workflow"
        options={workflows.map((item) => ({ id: item.id, title: item.name }))}
        selected={workflow?.id ?? null}
        onSelect={(id) => {
          setWorkflowId(id);
          setStageId(null);
        }}
      />
      <Choices
        label="This thread is"
        options={draft.stages.map((item) => ({
          id: item.stepId,
          title: `${item.label} · stage ${item.index} of ${item.total}`,
        }))}
        selected={stage?.stepId ?? null}
        onSelect={setStageId}
      />
      <View className="gap-1">
        <Text className="text-sm font-t3-medium text-foreground">Next</Text>
        <Text className="text-sm text-foreground-muted">
          {draft.next
            ? [
                draft.next.gated ? `Approval, then ${draft.next.label}` : draft.next.label,
                draft.next.role?.name,
                draft.next.role?.model,
              ]
                .filter(Boolean)
                .join(" · ")
            : "Nothing: this is the last stage."}
        </Text>
      </View>
      <View className="gap-1">
        <Text className="text-sm font-t3-medium text-foreground">Title</Text>
        <AppTextInput
          accessibilityLabel="Feature title"
          className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
          maxLength={200}
          value={title}
          onChangeText={setTitle}
        />
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-500">
          {error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        className="items-center rounded-full bg-subtle-strong px-4 py-3 disabled:opacity-40"
        disabled={busy || !stage || !title.trim()}
        onPress={() => void submit()}
      >
        <Text className="text-base font-t3-medium text-foreground">Make feature</Text>
      </Pressable>
    </View>
  );
}

function Choices(props: {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <View className="gap-1">
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className="overflow-hidden rounded-xl border border-border-subtle">
        {props.options.map((option) => (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityState={{ selected: option.id === props.selected }}
            className="flex-row items-center justify-between border-b border-border-subtle px-3 py-3"
            onPress={() => props.onSelect(option.id)}
          >
            <Text className="text-base text-foreground">{option.title}</Text>
            {option.id === props.selected ? (
              <Text className="text-base text-foreground">✓</Text>
            ) : null}
          </Pressable>
        ))}
      </View>
    </View>
  );
}
