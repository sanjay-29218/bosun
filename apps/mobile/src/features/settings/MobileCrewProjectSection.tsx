import { useNavigation } from "@react-navigation/native";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { CREW_DISPATCH_STATE, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { projectBotId } from "@t3tools/client-runtime/state/bot-rail";
import { botsEnvironment } from "../../state/bots";
import { rolesEnvironment } from "../../state/roles";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";
import { SettingsSection } from "./components/SettingsSection";
import { MobileCrewMembersPanel } from "./MobileRoleConfigurationPanel";

export function MobileCrewProjectSection(props: {
  readonly project: EnvironmentProject;
  readonly environmentLabel: string;
}) {
  const navigation = useNavigation();
  const { project } = props;
  const serverConfig = useEnvironmentServerConfig(project.environmentId);
  const projectSettings = resolveProjectSettings(
    serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    project.id,
    project,
  );
  const projectDefaultModelSelection = resolveDefaultableModelSelection(
    serverConfig,
    projectSettings.settings.defaultModelSelection,
  );
  const modelSelection = resolveNewTaskModelSelection({
    draftSelection: null,
    projectDefaultSelection: projectDefaultModelSelection,
    stickySelection: null,
    modelOptions: buildModelOptions(serverConfig, projectDefaultModelSelection),
  });
  const snapshot = useEnvironmentQuery(
    rolesEnvironment.snapshot({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  // Work started here runs as the bot that owns the project.
  const bots = useEnvironmentQuery(
    serverConfig?.environment.capabilities.bots === true
      ? botsEnvironment.list({ environmentId: project.environmentId, input: {} })
      : null,
  );
  const ownerName = bots.data?.find((bot) => bot.id === projectBotId(project))?.name ?? "Captain";
  const start = useAtomCommand(rolesEnvironment.start);
  const answer = useAtomCommand(rolesEnvironment.answer);
  const cancel = useAtomCommand(rolesEnvironment.cancel);
  const retry = useAtomCommand(rolesEnvironment.retry);
  const [taskText, setTaskText] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const memberNames = useMemo(
    () => new Map(snapshot.data?.members.map((member) => [member.id, member.name]) ?? []),
    [snapshot.data?.members],
  );
  const runs = snapshot.data?.runs ?? [];
  const handoffs = snapshot.data?.handoffs ?? [];

  const openThread = (threadId: string) =>
    navigation.navigate("Thread", {
      environmentId: String(project.environmentId),
      threadId,
    });

  const startOwner = async () => {
    const task = taskText.trim();
    if (!task || !modelSelection || busyId) return;
    setActionError(null);
    setBusyId("start");
    try {
      const result = await start({
        environmentId: project.environmentId,
        input: {
          id: `bot-captain:${uuidv4()}`,
          projectId: project.id,
          modelSelection,
          taskText: task,
        },
      });
      if (result._tag === "Success") {
        setTaskText("");
        openThread(result.value.threadId);
      } else {
        setActionError(Cause.pretty(result.cause));
      }
    } finally {
      setBusyId(null);
    }
  };

  const answerQuestion = async (requestId: string) => {
    const text = answers[requestId]?.trim();
    if (!text || busyId) return;
    setActionError(null);
    setBusyId(requestId);
    try {
      const result = await answer({
        environmentId: project.environmentId,
        input: { projectId: project.id, requestId, text },
      });
      if (result._tag === "Success") {
        setAnswers((current) => ({ ...current, [requestId]: "" }));
        snapshot.refresh();
      } else {
        setActionError(Cause.pretty(result.cause));
      }
    } finally {
      setBusyId(null);
    }
  };

  const cancelRequest = async (requestId: string) => {
    if (busyId) return;
    setActionError(null);
    setBusyId(requestId);
    try {
      const result = await cancel({
        environmentId: project.environmentId,
        input: { projectId: project.id, requestId },
      });
      if (result._tag === "Success") snapshot.refresh();
      else setActionError(Cause.pretty(result.cause));
    } finally {
      setBusyId(null);
    }
  };

  const retryRequest = async (requestId: string) => {
    if (busyId) return;
    setActionError(null);
    setBusyId(requestId);
    try {
      const result = await retry({
        environmentId: project.environmentId,
        input: { projectId: project.id, requestId },
      });
      if (result._tag === "Success") snapshot.refresh();
      else setActionError(Cause.pretty(result.cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SettingsSection title={`Crew activity · ${props.environmentLabel}`}>
      <View className="gap-3 p-4">
        <Text className="text-xs text-foreground-muted">{project.workspaceRoot}</Text>
        <Text className="text-sm text-foreground-muted">
          Give {ownerName} a project task. Its Manager and Builder runs appear below.
        </Text>
        {!modelSelection ? (
          <Text className="text-sm text-foreground-muted">No available model.</Text>
        ) : null}
        <AppTextInput
          accessibilityLabel={`Task for ${ownerName} on ${props.environmentLabel}`}
          multiline
          className="min-h-24 rounded-xl border-continuous bg-card px-3 py-2 text-base text-foreground"
          placeholder="What should the crew do?"
          value={taskText}
          onChangeText={setTaskText}
          maxLength={8000}
          editable={busyId === null}
          textAlignVertical="top"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Start ${ownerName}`}
          disabled={!modelSelection || !taskText.trim() || busyId !== null}
          onPress={() => void startOwner()}
          className="self-start rounded-full bg-subtle-strong px-4 py-2 active:opacity-70 disabled:opacity-40"
        >
          <Text className="text-sm font-t3-medium text-foreground">Start {ownerName}</Text>
        </Pressable>
        {snapshot.error ? <Text className="text-sm text-red-500">{snapshot.error}</Text> : null}
        {actionError ? <Text className="text-sm text-red-500">{actionError}</Text> : null}
        {handoffs
          .filter((handoff) => handoff.status === "needs-input")
          .map((handoff) => (
            <View key={handoff.id} className="gap-2 rounded-xl border border-border-subtle p-3">
              <Text className="text-sm font-t3-medium text-foreground">Needs your answer</Text>
              <Text className="text-sm text-foreground">{handoff.questionText}</Text>
              <AppTextInput
                accessibilityLabel={`Answer request ${handoff.id}`}
                multiline
                className="min-h-16 rounded-xl border-continuous bg-card px-3 py-2 text-base text-foreground"
                value={answers[handoff.id] ?? ""}
                onChangeText={(text) =>
                  setAnswers((current) => ({ ...current, [handoff.id]: text }))
                }
                maxLength={8000}
                textAlignVertical="top"
              />
              <View className="flex-row gap-3">
                <Pressable
                  accessibilityRole="button"
                  disabled={!answers[handoff.id]?.trim() || busyId !== null}
                  onPress={() => void answerQuestion(handoff.id)}
                >
                  <Text className="text-sm font-t3-medium text-foreground">Send answer</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={busyId !== null}
                  onPress={() => void cancelRequest(handoff.id)}
                >
                  <Text className="text-sm text-foreground-muted">Cancel</Text>
                </Pressable>
              </View>
            </View>
          ))}
        {runs.length > 0 ? (
          <Text className="text-sm font-t3-medium text-foreground">Recent runs</Text>
        ) : null}
        {runs.map((run) => (
          <Pressable
            key={run.id}
            accessibilityRole="button"
            accessibilityLabel={`Open ${memberNames.get(run.memberId) ?? run.memberId} thread`}
            onPress={() => openThread(run.threadId)}
            className="flex-row items-center justify-between gap-3 py-1.5 active:opacity-70"
          >
            <View className="min-w-0 flex-1">
              <Text className="text-sm text-foreground" numberOfLines={1}>
                {memberNames.get(run.memberId) ?? run.memberId}
              </Text>
              {run.lastError ? (
                <Text className="text-xs text-red-500" numberOfLines={1}>
                  {run.lastError}
                </Text>
              ) : null}
            </View>
            <Text className="text-xs text-foreground-muted">
              {run.dispatchState === CREW_DISPATCH_STATE.QUEUED
                ? CREW_DISPATCH_STATE.QUEUED
                : run.turnState}
            </Text>
          </Pressable>
        ))}
        {handoffs.length > 0 ? (
          <Text className="text-sm font-t3-medium text-foreground">Requests</Text>
        ) : null}
        {handoffs.map((handoff) => (
          <View key={handoff.id} className="flex-row items-center justify-between gap-3 py-1">
            <View className="min-w-0 flex-1">
              <Text className="text-sm text-foreground" numberOfLines={1}>
                {memberNames.get(handoff.targetMemberId) ?? handoff.targetMemberId}:{" "}
                {handoff.taskText}
              </Text>
              {handoff.lastError || handoff.responseText ? (
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  {handoff.lastError ?? handoff.responseText}
                </Text>
              ) : null}
            </View>
            <Text className="text-xs text-foreground-muted">{handoff.status}</Text>
            {handoff.status === "failed" || handoff.status === "cancelled" ? (
              <Pressable
                accessibilityRole="button"
                disabled={busyId !== null}
                onPress={() => void retryRequest(handoff.id)}
              >
                <Text className="text-xs font-t3-medium text-foreground">Retry</Text>
              </Pressable>
            ) : handoff.status === "queued" || handoff.status === "running" ? (
              <Pressable
                accessibilityRole="button"
                disabled={busyId !== null}
                onPress={() => void cancelRequest(handoff.id)}
              >
                <Text className="text-xs font-t3-medium text-foreground">Cancel</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        <MobileCrewMembersPanel
          environmentId={project.environmentId}
          projectId={project.id}
          members={snapshot.data?.members ?? []}
        />
      </View>
    </SettingsSection>
  );
}
