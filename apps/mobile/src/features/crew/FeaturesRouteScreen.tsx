import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import {
  crewCurrentThreadId,
  crewFailureDetail,
  crewFeatureState,
  crewGroupByPhase,
  crewGroupByStage,
  crewMostUsedWorkflowId,
  crewNeedsYou,
  crewStageLine,
  humanizeCrewId,
  type CrewFeature,
} from "@t3tools/client-runtime/state/crew";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { FeatureCardState, WorkflowDefinition } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { featuresEnvironment, useCrewBoards } from "../../state/features";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";

interface FeatureItem {
  readonly project: EnvironmentProject;
  readonly feature: CrewFeature;
}

const STATE_LABEL: Partial<Record<FeatureCardState, { label: string; className: string }>> = {
  approval: { label: "Approval", className: "text-warning-foreground" },
  input: { label: "Input", className: "text-adaptive-indigo-600-300" },
  "your-call": { label: "Your call", className: "text-warning-foreground" },
  failed: { label: "Failed", className: "text-danger-foreground" },
  working: { label: "Working", className: "text-adaptive-sky-600-400" },
  queued: { label: "Queued", className: "text-foreground-secondary" },
  paused: { label: "Paused", className: "text-foreground-secondary" },
  cancelled: { label: "Cancelled", className: "text-foreground-secondary" },
  done: { label: "Done", className: "text-adaptive-emerald-700-300" },
};

const ALL_SCOPE = "all";

function featureLine(feature: CrewFeature): string | null {
  const snapshot = feature.snapshot;
  const stage = snapshot?.stage;
  if (!snapshot || !stage) return null;
  if (crewFeatureState(feature) === "failed") {
    const failure = crewFailureDetail(snapshot);
    if (failure) return `${humanizeCrewId(stage.stepId)} · ${failure}`;
  }
  return crewStageLine(snapshot.definition, {
    ...stage,
    featureId: snapshot.featureId,
    state: crewFeatureState(feature),
    current: true,
  });
}

function FeatureRow(props: { readonly item: FeatureItem; readonly showProject: boolean }) {
  const navigation = useNavigation();
  const { project, feature } = props.item;
  const state = crewFeatureState(feature);
  const label = STATE_LABEL[state];
  const threadId = crewCurrentThreadId(feature);
  const pause = useAtomCommand(featuresEnvironment.pause);
  const resume = useAtomCommand(featuresEnvironment.resume);
  const cancel = useAtomCommand(featuresEnvironment.cancel);
  const reopen = useAtomCommand(featuresEnvironment.reopen);
  const startNow = useAtomCommand(featuresEnvironment.startNow);
  const start = useAtomCommand(featuresEnvironment.start);
  const base = { projectId: project.id, featureId: feature.record.id };
  const target = <I,>(input: I) => ({ environmentId: project.environmentId, input });
  const action = (name: string) => ({ ...base, requestId: `crew-${name}:${uuidv4()}` });

  // The lifecycle a row offers without opening the stage: each state's way out.
  const notStarted =
    feature.snapshot?.executionConfigured === false && feature.record.status === "open";
  const actions: MenuAction[] = [
    ...(notStarted ? [{ id: "start", title: "Start" }] : []),
    ...(state === "queued" ? [{ id: "start-now", title: "Start now" }] : []),
    ...(state === "paused" ? [{ id: "resume", title: "Resume" }] : []),
    ...(["working", "queued", "approval", "input", "your-call", "failed"].includes(state)
      ? [{ id: "pause", title: "Pause" }]
      : []),
    ...(state === "cancelled" ? [{ id: "reopen", title: "Reopen" }] : []),
    ...(state !== "cancelled" && state !== "done"
      ? [{ id: "cancel", title: "Cancel feature", attributes: { destructive: true } }]
      : []),
  ];
  const onAction = (id: string) => {
    if (id === "start") void start(target(base));
    if (id === "start-now") void startNow(target(base));
    if (id === "resume") void resume(target(action("resume")));
    if (id === "pause") void pause(target(action("pause")));
    if (id === "reopen") void reopen(target(action("reopen")));
    if (id === "cancel") void cancel(target(action("cancel")));
  };
  const line = featureLine(feature);

  return (
    <ControlPillMenu
      accessibilityLabel={`${feature.record.title} actions`}
      shouldOpenOnLongPress
      actions={actions}
      onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        disabled={threadId === null}
        onPress={() => {
          if (threadId === null) return;
          navigation.navigate("Thread", {
            environmentId: String(project.environmentId),
            threadId: String(threadId),
          });
        }}
        className="gap-0.5 border-b border-border px-4 py-3 active:opacity-70"
      >
        <View className="flex-row items-center gap-2">
          {props.showProject ? (
            <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
              {project.title}
            </Text>
          ) : null}
          {label ? (
            <Text className={cn("font-t3-bold text-xs", label.className)}>{label.label}</Text>
          ) : null}
        </View>
        <Text className="font-t3-medium text-base text-foreground" numberOfLines={2}>
          {feature.record.title}
        </Text>
        {line ? (
          <Text
            className={cn(
              "text-xs",
              state === "failed" ? "text-danger-foreground" : "text-foreground-secondary",
            )}
            numberOfLines={1}
          >
            {line}
          </Text>
        ) : null}
      </Pressable>
    </ControlPillMenu>
  );
}

function GroupHeader(props: {
  readonly label: string;
  readonly count: number;
  readonly onPress?: () => void;
  readonly expanded?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={props.onPress ? "button" : "header"}
      disabled={!props.onPress}
      onPress={props.onPress}
      className="px-4 pb-1.5 pt-5"
    >
      <Text className="font-t3-bold text-xs uppercase tracking-[1.1px] text-foreground-secondary">
        {props.label} ({props.count}){props.onPress ? (props.expanded ? "  ▾" : "  ▸") : ""}
      </Text>
    </Pressable>
  );
}

/**
 * Every feature across connected Crew projects: Needs you first, then the stage each
 * feature is at, with Done folded at the end. The Workflow switch groups one workflow's
 * features by its stages instead, with gate rows between them.
 */
export function FeaturesRouteScreen() {
  const navigation = useNavigation();
  const boards = useCrewBoards();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [scope, setScope] = useState(ALL_SCOPE);
  const [doneExpanded, setDoneExpanded] = useState(false);

  const items = useMemo(
    () =>
      boards.flatMap((board) =>
        scope === ALL_SCOPE ||
        scope === scopedProjectKey(board.project.environmentId, board.project.id)
          ? board.features.map((feature) => ({ project: board.project, feature }))
          : [],
      ),
    [boards, scope],
  );
  const byFeature = useMemo(
    () => new Map(items.map((item) => [item.feature, item] as const)),
    [items],
  );
  const workflows = useMemo(() => {
    const definitions = new Map<string, WorkflowDefinition>();
    for (const { feature } of items) {
      const definition = feature.snapshot?.definition;
      if (definition && !definitions.has(definition.id)) definitions.set(definition.id, definition);
    }
    return definitions;
  }, [items]);
  const features = items.map((item) => item.feature);
  const savedWorkflowId = AsyncResult.isSuccess(preferences)
    ? preferences.value.crewWorkflowView?.[scope]
    : undefined;
  const workflow = savedWorkflowId ? (workflows.get(savedWorkflowId) ?? null) : null;
  const setWorkflowView = (workflowId: string | null) =>
    savePreferences({
      transform: (current) => {
        const { [scope]: _previous, ...rest } = current.crewWorkflowView ?? {};
        return { crewWorkflowView: workflowId === null ? rest : { ...rest, [scope]: workflowId } };
      },
    });

  const needsYou = crewNeedsYou(features);
  const showProject = scope === ALL_SCOPE && boards.length > 1;
  const rows = (list: ReadonlyArray<CrewFeature>) =>
    list.map((feature) => {
      const item = byFeature.get(feature)!;
      return (
        <FeatureRow
          key={`${item.project.environmentId}:${feature.record.id}`}
          item={item}
          showProject={showProject}
        />
      );
    });
  const doneGroup = (key: string, list: ReadonlyArray<CrewFeature>) => (
    <View key={key}>
      <GroupHeader
        label="Done"
        count={list.length}
        expanded={doneExpanded}
        onPress={() => setDoneExpanded((value) => !value)}
      />
      {doneExpanded ? rows(list) : null}
    </View>
  );

  const scopeActions: MenuAction[] = [
    { id: ALL_SCOPE, title: "All projects", state: scope === ALL_SCOPE ? "on" : "off" },
    ...boards.map((board) => {
      const key = scopedProjectKey(board.project.environmentId, board.project.id);
      return { id: key, title: board.project.title, state: scope === key ? "on" : "off" } as const;
    }),
  ];
  const viewActions: MenuAction[] = [
    { id: "phases", title: "Phases", state: workflow === null ? "on" : "off" },
    {
      id: "workflow",
      title: "Workflow",
      subtitle: "Group one workflow by its stages",
      subactions: [...workflows.values()].map((definition) => ({
        id: `workflow:${definition.id}`,
        title: definition.name,
        state: workflow?.id === definition.id ? "on" : "off",
      })),
    },
  ];
  const onViewAction = (id: string) => {
    if (id === "phases") return void setWorkflowView(null);
    if (id === "workflow") {
      const fallback = crewMostUsedWorkflowId(features);
      if (fallback) void setWorkflowView(fallback);
      return;
    }
    if (id.startsWith("workflow:")) void setWorkflowView(id.slice("workflow:".length));
  };

  const scopeLabel =
    scope === ALL_SCOPE
      ? "All projects"
      : (boards.find(
          (board) => scopedProjectKey(board.project.environmentId, board.project.id) === scope,
        )?.project.title ?? "All projects");

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" className="flex-1 bg-background">
      <View className="flex-row flex-wrap gap-2 px-4 pt-3">
        <ControlPillMenu
          accessibilityLabel="Choose projects"
          actions={scopeActions}
          onPressAction={({ nativeEvent }) => setScope(nativeEvent.event)}
        >
          <View className="rounded-full bg-subtle-strong px-3.5 py-2">
            <Text className="text-sm font-t3-medium text-foreground">{scopeLabel} ▾</Text>
          </View>
        </ControlPillMenu>
        <ControlPillMenu
          accessibilityLabel="Group features"
          actions={viewActions}
          onPressAction={({ nativeEvent }) => onViewAction(nativeEvent.event)}
        >
          <View className="rounded-full bg-subtle-strong px-3.5 py-2">
            <Text className="text-sm font-t3-medium text-foreground">
              {workflow === null ? "Phases" : `Workflow · ${workflow.name}`} ▾
            </Text>
          </View>
        </ControlPillMenu>
      </View>

      {features.length === 0 ? (
        <View className="items-center gap-3 px-8 py-16">
          <Text className="font-t3-bold text-lg text-foreground">No features yet</Text>
          <Text className="text-center text-sm text-foreground-secondary">
            Pick a workflow when you start a task, and the crew runs it stage by stage.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
            className="rounded-full bg-primary px-4 py-2.5 active:opacity-70"
          >
            <Text className="font-t3-bold text-sm text-primary-foreground">Start a feature</Text>
          </Pressable>
        </View>
      ) : workflow !== null ? (
        (() => {
          const grouped = crewGroupByStage(features, workflow);
          return (
            <>
              {grouped.items.map((item) =>
                item.kind === "gate" ? (
                  <View key={item.key} className="flex-row items-center gap-2 px-4 py-2">
                    <View className="h-px flex-1 bg-border" />
                    <Text
                      className={cn(
                        "text-xs",
                        item.waiting > 0 ? "text-warning-foreground" : "text-foreground-secondary",
                      )}
                    >
                      {item.label}
                      {item.waiting > 0 ? ` · ${item.waiting} waiting` : ""}
                    </Text>
                    <View className="h-px flex-1 bg-border" />
                  </View>
                ) : item.key === "done" ? (
                  doneGroup(item.key, item.features)
                ) : (
                  <View key={item.key}>
                    <GroupHeader label={item.label} count={item.features.length} />
                    {rows(item.features)}
                  </View>
                ),
              )}
              {grouped.hiddenCount > 0 ? (
                <Text className="px-4 py-4 text-xs text-foreground-secondary">
                  {grouped.hiddenCount === 1
                    ? "1 feature on another workflow is hidden."
                    : `${grouped.hiddenCount} features on other workflows are hidden.`}
                </Text>
              ) : null}
            </>
          );
        })()
      ) : (
        <>
          {needsYou.length > 0 ? (
            <View>
              <GroupHeader label="Needs you" count={needsYou.length} />
              {rows(needsYou)}
            </View>
          ) : null}
          {crewGroupByPhase(features).map((group) =>
            group.key === "done" ? (
              doneGroup(group.key, group.features)
            ) : (
              <View key={group.key}>
                <GroupHeader label={group.label} count={group.features.length} />
                {rows(group.features)}
              </View>
            ),
          )}
        </>
      )}
    </ScrollView>
  );
}
