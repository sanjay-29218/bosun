import type { MenuAction } from "@react-native-menu/menu";
import { workThreadLabel } from "@t3tools/client-runtime/state/work-groups";
import {
  collectNeedsYou,
  FEATURE_CARD_ACTION_LABELS,
  FEATURE_COLUMN_LABELS,
  featureCardActions,
  featureCardKey,
  featureCardQuickActions,
  featureRef,
  groupFeaturesByColumn,
  matchesFeatureSearch,
  threadsByFeature,
  type EnvironmentFeatureCard,
  type FeatureColumn,
  type NeedsYouKind,
} from "@t3tools/client-runtime/state/crew-board";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View, type StyleProp, type ViewStyle } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { featuresEnvironment, useFeatureBoard } from "../../state/features";
import { useAtomCommand } from "../../state/use-atom-command";

/** Mobile lists the columns top to bottom, so what waits on you comes first. */
const COLUMN_ORDER: ReadonlyArray<FeatureColumn> = ["needs-you", "working", "todo", "done"];

function FeatureRow(props: {
  readonly card: EnvironmentFeatureCard;
  readonly projectTitle: string | null;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const { card, onOpenThread } = props;
  const start = useAtomCommand(featuresEnvironment.start);
  const setStatus = useAtomCommand(featuresEnvironment.setStatus);
  const feature = { projectId: card.projectId, featureId: card.featureId };

  const onAction = (id: string) => {
    if (id === "start") {
      void start({ environmentId: card.environmentId, input: feature }).then((result) => {
        if (result._tag === "Success") onOpenThread(card.environmentId, result.value.leadThreadId);
      });
    }
    if (id === "close" || id === "reopen") {
      void setStatus({
        environmentId: card.environmentId,
        input: { ...feature, status: id === "close" ? "closed" : "open" },
      });
    }
  };
  const actions: MenuAction[] = featureCardActions(card).map((id) => ({
    id,
    title: FEATURE_CARD_ACTION_LABELS[id],
    ...(id === "close" ? { attributes: { destructive: true } } : {}),
  }));
  const ref = featureRef(card);
  const leadThreadId = card.leadThreadId;

  return (
    <Menu
      accessibilityLabel={`${card.title} actions`}
      shouldOpenOnLongPress
      actions={actions}
      onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        disabled={leadThreadId === null}
        onPress={() => {
          if (leadThreadId !== null) onOpenThread(card.environmentId, leadThreadId);
        }}
        className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:opacity-70"
      >
        <View className="min-w-0 flex-1 gap-0.5">
          {props.projectTitle !== null ? (
            <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
              {props.projectTitle}
            </Text>
          ) : null}
          <Text className="font-t3-medium text-base text-foreground" numberOfLines={2}>
            {card.title}
          </Text>
          {ref ? (
            <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
              {ref}
            </Text>
          ) : null}
        </View>
        {featureCardQuickActions(card).map((id) => (
          <Pressable
            key={id}
            accessibilityRole="button"
            onPress={() => onAction(id)}
            className="rounded-full bg-subtle-strong px-3 py-1.5 active:opacity-70"
          >
            <Text className="font-t3-medium text-xs text-foreground">
              {FEATURE_CARD_ACTION_LABELS[id]}
            </Text>
          </Pressable>
        ))}
      </Pressable>
    </Menu>
  );
}

const NEEDS_YOU_THREAD_LABEL: Record<NeedsYouKind, { label: string; className: string }> = {
  approval: { label: "Approval", className: "text-warning-foreground" },
  question: { label: "Input", className: "text-adaptive-indigo-600-300" },
};

/** A thread outside any feature that waits on you: a tool approval or a question. */
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
 * The feature board for the projects the thread list shows, its columns as groups: Needs you
 * (with chats outside a feature that wait on you), Working, Todo, then Done folded.
 */
export function FeatureBoard(props: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** Thread shells the list shows: they place each feature and join Needs you. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** False while another screen covers the board, which then stops re-reading. */
  readonly active: boolean;
  readonly searchQuery: string;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  readonly onStartFeature: () => void;
  readonly contentContainerStyle?: StyleProp<ViewStyle>;
  readonly automaticInsets?: boolean;
}) {
  const board = useFeatureBoard(
    props.projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    props.active,
  );
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
  const columns = useMemo(() => {
    const cards = board.cards.filter((card) =>
      matchesFeatureSearch(card, props.searchQuery, [
        projectTitles.get(scopedProjectKey(card.environmentId, card.projectId)),
      ]),
    );
    const groups = new Map(
      groupFeaturesByColumn(cards, threadsByFeature(props.threads)).map((group) => [
        group.column,
        group.cards,
      ]),
    );
    return COLUMN_ORDER.map((column) => ({ column, cards: groups.get(column) ?? [] }));
  }, [board.cards, projectTitles, props.searchQuery, props.threads]);
  const needsYouThreads = useMemo(() => {
    const text = props.searchQuery.trim().toLowerCase();
    const shells = props.threads.filter(
      (shell) =>
        !shell.feature &&
        projectTitles.has(scopedProjectKey(shell.environmentId, shell.projectId)) &&
        (!text || shell.title.toLowerCase().includes(text)),
    );
    return collectNeedsYou(shells)
      .flatMap((group) => group.items)
      .sort((a, b) => a.since.localeCompare(b.since) || a.key.localeCompare(b.key));
  }, [projectTitles, props.searchQuery, props.threads]);

  const projectTitleFor = (environmentId: EnvironmentId, projectId: ProjectId) =>
    showProject ? (projectTitles.get(scopedProjectKey(environmentId, projectId)) ?? null) : null;
  const rows = (list: ReadonlyArray<EnvironmentFeatureCard>) =>
    list.map((card) => (
      <FeatureRow
        key={featureCardKey(card)}
        card={card}
        projectTitle={projectTitleFor(card.environmentId, card.projectId)}
        onOpenThread={props.onOpenThread}
      />
    ));

  let body: ReactNode;
  if (board.cards.length === 0 && needsYouThreads.length === 0) {
    body = board.pending ? (
      <Text className="px-4 py-6 text-sm text-foreground-secondary">Loading features…</Text>
    ) : (
      <View className="items-center gap-3 px-8 py-16">
        <Text className="font-t3-bold text-lg text-foreground">No features yet</Text>
        <Text className="text-center text-sm text-foreground-secondary">
          Start a task as a feature, and its lead works through the brief with the crew.
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
  } else {
    const empty = columns.every((group) => group.cards.length === 0);
    body = (
      <>
        {columns.map(({ column, cards }) => {
          if (column === "done") {
            if (cards.length === 0) return null;
            return (
              <View key={column}>
                <GroupHeader
                  label={FEATURE_COLUMN_LABELS.done}
                  count={cards.length}
                  expanded={doneExpanded}
                  onPress={() => setDoneExpanded((value) => !value)}
                />
                {doneExpanded ? rows(cards) : null}
              </View>
            );
          }
          const threads = column === "needs-you" ? needsYouThreads : [];
          if (cards.length === 0 && threads.length === 0) return null;
          return (
            <View key={column}>
              <GroupHeader
                label={FEATURE_COLUMN_LABELS[column]}
                count={cards.length + threads.length}
              />
              {rows(cards)}
              {threads.map((item) => (
                <NeedsYouThreadRow
                  key={item.key}
                  shell={item.shell}
                  kind={item.kind}
                  projectTitle={projectTitleFor(item.shell.environmentId, item.shell.projectId)}
                  onOpenThread={props.onOpenThread}
                />
              ))}
            </View>
          );
        })}
        {empty && needsYouThreads.length === 0 ? (
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
      {board.errors.map((error) => (
        <Text key={error} className="px-4 pt-3 text-sm text-danger-foreground">
          {error}
        </Text>
      ))}
      {body}
    </ScrollView>
  );
}
