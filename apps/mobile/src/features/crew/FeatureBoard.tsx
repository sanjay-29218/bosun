import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { formatCrewStageLine } from "@t3tools/client-runtime/crew-stage";
import { workThreadLabel } from "@t3tools/client-runtime/state/work-groups";
import {
  buildFeatureStageBoard,
  collectNeedsYou,
  DONE_COLUMN_ID,
  FEATURE_CARD_ACTION_LABELS,
  FEATURE_PHASE_LABELS,
  featureCardActions,
  featureCardKey,
  groupFeaturesByPhase,
  matchesFeatureSearch,
  mostUsedWorkflowId,
  parseFeatureSearch,
  type NeedsYouKind,
  stageLabel,
  type EnvironmentFeatureCard,
  type FeatureCardActionId,
} from "@t3tools/client-runtime/state/crew-board";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  featureIssueRef,
  type EnvironmentId,
  type FeatureCardState,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View, type StyleProp, type ViewStyle } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { featuresEnvironment, useFeatureBoard } from "../../state/features";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";

const STATE_LABEL: Partial<Record<FeatureCardState, { label: string; className: string }>> = {
  approval: { label: "Approval", className: "text-warning-foreground" },
  input: { label: "Input", className: "text-adaptive-indigo-600-300" },
  "your-call": { label: "Your call", className: "text-warning-foreground" },
  failed: { label: "Failed", className: "text-danger-foreground" },
  working: { label: "Working", className: "text-adaptive-sky-600-400" },
  queued: { label: "Queued", className: "text-foreground-secondary" },
  paused: { label: "Paused", className: "text-foreground-secondary" },
  cancelled: { label: "Stopped", className: "text-foreground-secondary" },
  done: { label: "Done", className: "text-adaptive-emerald-700-300" },
};

/**
 * The lifecycle a row offers without opening the stage. Decisions that need a note or a
 * choice (approve, answer, send back…) stay on the stage thread's card.
 */
const ROW_ACTIONS: ReadonlySet<FeatureCardActionId> = new Set([
  "start",
  "start-now",
  "pause",
  "resume",
  "cancel",
]);

function rowActions(card: EnvironmentFeatureCard): FeatureCardActionId[] {
  // Reopening a finished feature asks for a stage, which the stage thread's card offers.
  if (card.state === "cancelled") return ["reopen"];
  return featureCardActions(card).filter((id) => ROW_ACTIONS.has(id));
}

function featureLine(card: EnvironmentFeatureCard): string | null {
  const issue = card.issue ? featureIssueRef(card.issue) : null;
  if (!card.stage) return issue;
  const stage =
    card.state === "failed" && card.detail
      ? `${stageLabel(card.stage.stepId)} · ${card.detail}`
      : `${formatCrewStageLine(card.stage)} · ${stageLabel(card.stage.role)}`;
  return issue ? `${issue} · ${stage}` : stage;
}

function FeatureRow(props: {
  readonly card: EnvironmentFeatureCard;
  readonly projectTitle: string | null;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const { card } = props;
  const label = STATE_LABEL[card.state];
  const start = useAtomCommand(featuresEnvironment.start);
  const startNow = useAtomCommand(featuresEnvironment.startNow);
  const pause = useAtomCommand(featuresEnvironment.pause);
  const resume = useAtomCommand(featuresEnvironment.resume);
  const cancel = useAtomCommand(featuresEnvironment.cancel);
  const reopen = useAtomCommand(featuresEnvironment.reopen);
  const base = { projectId: card.projectId, featureId: card.featureId };
  const target = <I,>(input: I) => ({ environmentId: card.environmentId, input });
  const action = (name: string) => ({ ...base, requestId: `crew-${name}:${uuidv4()}` });

  const actions: MenuAction[] = rowActions(card).map((id) => ({
    id,
    title: FEATURE_CARD_ACTION_LABELS[id],
    ...(id === "cancel" ? { attributes: { destructive: true } } : {}),
  }));
  const onAction = (id: string) => {
    if (id === "start") void start(target(base));
    if (id === "start-now") void startNow(target(base));
    if (id === "resume") void resume(target(action("resume")));
    if (id === "pause") void pause(target(action("pause")));
    if (id === "reopen") void reopen(target(action("reopen")));
    if (id === "cancel") void cancel(target(action("cancel")));
  };
  const line = featureLine(card);
  const threadId = card.threadId;

  return (
    <Menu
      accessibilityLabel={`${card.title} actions`}
      shouldOpenOnLongPress
      actions={actions}
      onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        disabled={threadId === null}
        onPress={() => {
          if (threadId !== null) props.onOpenThread(card.environmentId, threadId);
        }}
        className="gap-0.5 border-b border-border px-4 py-3 active:opacity-70"
      >
        <View className="flex-row items-center gap-2">
          {props.projectTitle !== null ? (
            <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
              {props.projectTitle}
            </Text>
          ) : null}
          {label ? (
            <Text className={cn("font-t3-bold text-xs", label.className)}>{label.label}</Text>
          ) : null}
        </View>
        <Text className="font-t3-medium text-base text-foreground" numberOfLines={2}>
          {card.title}
        </Text>
        {line ? (
          <Text
            className={cn(
              "text-xs",
              card.state === "failed" ? "text-danger-foreground" : "text-foreground-secondary",
            )}
            numberOfLines={1}
          >
            {line}
          </Text>
        ) : null}
      </Pressable>
    </Menu>
  );
}

const NEEDS_YOU_THREAD_LABEL: Record<NeedsYouKind, { label: string; className: string }> = {
  approval: { label: "Approval", className: "text-warning-foreground" },
  question: { label: "Input", className: "text-adaptive-indigo-600-300" },
  problem: { label: "Problem", className: "text-danger-foreground" },
};

/** A thread that waits on you outside a feature card: a tool approval or a question. */
function NeedsYouThreadRow(props: {
  readonly shell: EnvironmentThreadShell;
  readonly kind: NeedsYouKind;
  readonly projectTitle: string | null;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const label = NEEDS_YOU_THREAD_LABEL[props.kind];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => props.onOpenThread(props.shell.environmentId, props.shell.id)}
      className="gap-0.5 border-b border-border px-4 py-3 active:opacity-70"
    >
      <View className="flex-row items-center gap-2">
        {props.projectTitle !== null ? (
          <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
            {props.projectTitle}
          </Text>
        ) : null}
        <Text className={cn("font-t3-bold text-xs", label.className)}>{label.label}</Text>
      </View>
      <Text className="font-t3-medium text-base text-foreground" numberOfLines={2}>
        {workThreadLabel(props.shell) || "Untitled thread"}
      </Text>
    </Pressable>
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
 * The feature board for the projects the thread list shows: Needs you first, then each
 * phase, with Done folded at the end. The Workflow switch lays one workflow's features out
 * by its stages instead, with gate rows between them. Mobile shows the columns as groups.
 */
export function FeatureBoard(props: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** Thread shells the list shows; those in `projects` that wait on you join Needs you. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** False while another screen covers the board, which then stops re-reading. */
  readonly active: boolean;
  readonly searchQuery: string;
  /** Where the Workflow switch is remembered, such as the active bot and project filter. */
  readonly scopeKey: string;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  readonly onStartFeature: () => void;
  readonly contentContainerStyle?: StyleProp<ViewStyle>;
  readonly automaticInsets?: boolean;
}) {
  const { scopeKey } = props;
  const board = useFeatureBoard(
    props.projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    props.active,
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [doneExpanded, setDoneExpanded] = useState(false);

  const projectTitles = useMemo(
    () =>
      new Map(
        props.projects.map((project) => [
          scopedProjectKey(project.environmentId, project.id),
          project.title,
        ]),
      ),
    [props.projects],
  );
  const showProject = props.projects.length > 1;
  const cards = useMemo(() => {
    const search = parseFeatureSearch(props.searchQuery);
    return board.cards.filter((card) =>
      matchesFeatureSearch(card, search, [
        projectTitles.get(scopedProjectKey(card.environmentId, card.projectId)),
      ]),
    );
  }, [board.cards, projectTitles, props.searchQuery]);
  const needsYou = useMemo(() => {
    const text = parseFeatureSearch(props.searchQuery).text;
    const shells = props.threads.filter(
      (shell) =>
        projectTitles.has(scopedProjectKey(shell.environmentId, shell.projectId)) &&
        (!text || shell.title.toLowerCase().includes(text)),
    );
    return collectNeedsYou({ cards, shells })
      .flatMap((group) => group.items)
      .sort((a, b) => a.since.localeCompare(b.since) || a.key.localeCompare(b.key));
  }, [cards, projectTitles, props.searchQuery, props.threads]);
  const workflows = useMemo(() => {
    const byId = new Map<string, { name: string; environmentId: EnvironmentId }>();
    for (const card of board.cards) {
      if (!byId.has(card.workflow.id))
        byId.set(card.workflow.id, {
          name: card.workflow.name,
          environmentId: card.environmentId,
        });
    }
    return byId;
  }, [board.cards]);

  const savedWorkflowId = AsyncResult.isSuccess(preferences)
    ? preferences.value.crewWorkflowView?.[scopeKey]
    : undefined;
  const workflow =
    savedWorkflowId && workflows.has(savedWorkflowId)
      ? { id: savedWorkflowId, ...workflows.get(savedWorkflowId)! }
      : null;
  // The library is global per environment; the stage layout uses the latest version.
  const definitions = useEnvironmentQuery(
    workflow
      ? workflowsEnvironment.definitions({ environmentId: workflow.environmentId, input: {} })
      : null,
  );
  const definition = workflow
    ? (definitions.data?.find((candidate) => candidate.id === workflow.id) ?? null)
    : null;
  const setWorkflowView = (workflowId: string | null) =>
    savePreferences({
      transform: (current) => {
        const rest = Object.fromEntries(
          Object.entries(current.crewWorkflowView ?? {}).filter(([key]) => key !== scopeKey),
        );
        return {
          crewWorkflowView: workflowId === null ? rest : { ...rest, [scopeKey]: workflowId },
        };
      },
    });

  const projectTitleFor = (environmentId: EnvironmentId, projectId: ProjectId) =>
    showProject ? (projectTitles.get(scopedProjectKey(environmentId, projectId)) ?? null) : null;
  const row = (card: EnvironmentFeatureCard) => (
    <FeatureRow
      key={featureCardKey(card)}
      card={card}
      projectTitle={projectTitleFor(card.environmentId, card.projectId)}
      onOpenThread={props.onOpenThread}
    />
  );
  const rows = (list: ReadonlyArray<EnvironmentFeatureCard>) => list.map(row);
  const doneGroup = (list: ReadonlyArray<EnvironmentFeatureCard>) => (
    <View key={DONE_COLUMN_ID}>
      <GroupHeader
        label="Done"
        count={list.length}
        expanded={doneExpanded}
        onPress={() => setDoneExpanded((value) => !value)}
      />
      {doneExpanded ? rows(list) : null}
    </View>
  );

  const viewActions: MenuAction[] = [
    { id: "phases", title: "Phases", state: workflow === null ? "on" : "off" },
    {
      id: "workflow",
      title: "Workflow",
      subtitle: "Group one workflow by its stages",
      subactions: [...workflows].map(([id, { name }]) => ({
        id: `workflow:${id}`,
        title: name,
        state: workflow?.id === id ? "on" : "off",
      })),
    },
  ];
  const onViewAction = (id: string) => {
    if (id === "phases") return void setWorkflowView(null);
    if (id === "workflow") {
      const fallback = mostUsedWorkflowId(board.cards);
      if (fallback) void setWorkflowView(fallback);
      return;
    }
    if (id.startsWith("workflow:")) void setWorkflowView(id.slice("workflow:".length));
  };

  let body: ReactNode;
  if (board.cards.length === 0 && needsYou.length === 0) {
    body = board.pending ? (
      <Text className="px-4 py-6 text-sm text-foreground-secondary">Loading features…</Text>
    ) : (
      <View className="items-center gap-3 px-8 py-16">
        <Text className="font-t3-bold text-lg text-foreground">No features yet</Text>
        <Text className="text-center text-sm text-foreground-secondary">
          Pick a workflow when you start a task, and the crew runs it stage by stage.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={props.onStartFeature}
          className="rounded-full bg-primary px-4 py-2.5 active:opacity-70"
        >
          <Text className="font-t3-bold text-sm text-primary-foreground">Start a feature</Text>
        </Pressable>
      </View>
    );
  } else if (definition !== null) {
    const stageBoard = buildFeatureStageBoard(definition, cards);
    const hiddenCount = stageBoard.hidden.reduce((sum, entry) => sum + entry.count, 0);
    body = (
      <>
        {stageBoard.columns.map((column) =>
          column.stepId === DONE_COLUMN_ID ? (
            doneGroup(column.cards)
          ) : (
            <View key={column.stepId}>
              <GroupHeader
                label={
                  column.onlyInRevision === null
                    ? stageLabel(column.stepId)
                    : `${stageLabel(column.stepId)} (version ${column.onlyInRevision})`
                }
                count={column.cards.length}
              />
              {rows(column.cards)}
              {column.gate ? (
                <View className="flex-row items-center gap-2 px-4 py-2">
                  <View className="h-px flex-1 bg-border" />
                  <Text
                    className={cn(
                      "text-xs",
                      column.waiting > 0 ? "text-warning-foreground" : "text-foreground-secondary",
                    )}
                  >
                    Approve {stageLabel(column.stepId).toLocaleLowerCase()}
                    {column.waiting > 0 ? ` · ${column.waiting} waiting` : ""}
                  </Text>
                  <View className="h-px flex-1 bg-border" />
                </View>
              ) : null}
            </View>
          ),
        )}
        {hiddenCount > 0 ? (
          <Text className="px-4 py-4 text-xs text-foreground-secondary">
            {hiddenCount === 1
              ? "1 feature on another workflow is hidden."
              : `${hiddenCount} features on other workflows are hidden.`}
          </Text>
        ) : null}
      </>
    );
  } else {
    const waitingCards = new Set(
      needsYou.flatMap((item) => (item.type === "feature" ? [item.card] : [])),
    );
    body = (
      <>
        {needsYou.length > 0 ? (
          <View>
            <GroupHeader label="Needs you" count={needsYou.length} />
            {needsYou.map((item) =>
              item.type === "feature" ? (
                row(item.card)
              ) : (
                <NeedsYouThreadRow
                  key={item.key}
                  shell={item.shell}
                  kind={item.kind}
                  projectTitle={projectTitleFor(item.shell.environmentId, item.shell.projectId)}
                  onOpenThread={props.onOpenThread}
                />
              ),
            )}
          </View>
        ) : null}
        {groupFeaturesByPhase(cards.filter((card) => !waitingCards.has(card))).map((group) =>
          group.cards.length === 0 ? null : group.phase === "done" ? (
            doneGroup(group.cards)
          ) : (
            <View key={group.phase}>
              <GroupHeader label={FEATURE_PHASE_LABELS[group.phase]} count={group.cards.length} />
              {rows(group.cards)}
            </View>
          ),
        )}
        {cards.length === 0 && needsYou.length === 0 ? (
          <Text className="px-4 py-6 text-sm text-foreground-secondary">No matching features</Text>
        ) : null}
      </>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior={props.automaticInsets === false ? "never" : "automatic"}
      contentContainerStyle={props.contentContainerStyle}
      keyboardDismissMode="on-drag"
      className="flex-1"
    >
      {board.cards.length > 0 ? (
        <View className="flex-row flex-wrap gap-2 px-4 pt-3">
          <Menu
            accessibilityLabel="Group features"
            actions={viewActions}
            onPressAction={({ nativeEvent }) => onViewAction(nativeEvent.event)}
          >
            <View className="rounded-full bg-subtle-strong px-3.5 py-2">
              <Text className="text-sm font-t3-medium text-foreground">
                {workflow === null ? "Phases" : `Workflow · ${workflow.name}`} ▾
              </Text>
            </View>
          </Menu>
        </View>
      ) : null}
      {board.errors.map((error) => (
        <Text key={error} className="px-4 pt-3 text-sm text-danger-foreground">
          {error}
        </Text>
      ))}
      {body}
    </ScrollView>
  );
}
