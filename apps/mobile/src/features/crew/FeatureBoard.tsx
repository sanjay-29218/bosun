import type { MenuAction } from "@react-native-menu/menu";
import { workThreadLabel } from "@t3tools/client-runtime/state/work-groups";
import {
  collectNeedsYou,
  FEATURE_CARD_ACTION_LABELS,
  FEATURE_STATUS_LABELS,
  featureCardActions,
  featureCardKey,
  featureCardQuickActions,
  featureOpenThreadId,
  featureProgress,
  featurePullRequest,
  featureRef,
  groupFeaturesByWork,
  matchesFeatureSearch,
  nestFeatureChildren,
  threadsByFeature,
  WORK_GROUP_LABELS,
  type EnvironmentFeatureCard,
  type FeatureStatus,
  type WorkPullRequest,
} from "@t3tools/client-runtime/state/crew-board";
import {
  featureForIssue,
  featuresByIssue,
  groupIssuesByMilestone,
  issueKey,
  issueRef,
  matchesIssueSearch,
  type EnvironmentIssue,
  type IssueTreeItem,
} from "@t3tools/client-runtime/state/issue-board";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View, type StyleProp, type ViewStyle } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { cn } from "../../lib/cn";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { featuresEnvironment, useFeatureBoard, useIssueList } from "../../state/features";
import { useAtomCommand } from "../../state/use-atom-command";

type BoardTab = "work" | "issues";

const TAB_OPTIONS = [
  { value: "work", label: "Work" },
  { value: "issues", label: "Issues" },
] as const satisfies readonly { value: BoardTab; label: string }[];

/** Where a started feature stands, as a row shows it. */
interface FeatureWork {
  readonly status: FeatureStatus;
  readonly pullRequest: WorkPullRequest | null;
  /** The thread a tap opens: the one asking you something, else the lead. */
  readonly openThreadId: ThreadId | null;
}

function PullRequestNumber(props: { readonly pullRequest: WorkPullRequest | null }) {
  if (props.pullRequest === null) return null;
  return (
    <Text className="text-xs tabular-nums text-foreground-secondary">
      #{props.pullRequest.number}
    </Text>
  );
}

function FeatureRow(props: {
  readonly card: EnvironmentFeatureCard;
  readonly projectTitle: string | null;
  readonly work: FeatureWork;
  /** A child feature, indented under its parent. */
  readonly nested?: boolean;
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
  const openThreadId = props.work.openThreadId;

  return (
    <Menu
      accessibilityLabel={`${card.title} actions`}
      shouldOpenOnLongPress
      actions={actions}
      onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        disabled={openThreadId === null}
        onPress={() => {
          if (openThreadId !== null) onOpenThread(card.environmentId, openThreadId);
        }}
        className={cn(
          "flex-row items-center gap-3 border-b border-border px-4 py-3 active:opacity-70",
          props.nested && "py-2 pl-8",
        )}
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
          <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
            {[featureRef(card), FEATURE_STATUS_LABELS[props.work.status]]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
        <PullRequestNumber pullRequest={props.work.pullRequest} />
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

/** An open issue or todo, with the started feature working on it, if any. */
function IssueRow(props: {
  readonly issue: EnvironmentIssue;
  readonly projectTitle: string | null;
  readonly work: (FeatureWork & { readonly environmentId: EnvironmentId }) | null;
  readonly nested?: boolean;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const { work } = props;
  const openThreadId = work?.openThreadId ?? null;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={openThreadId === null}
      onPress={() => {
        if (work !== null && openThreadId !== null)
          props.onOpenThread(work.environmentId, openThreadId);
      }}
      className={cn(
        "flex-row items-center gap-3 border-b border-border px-4 py-3 active:opacity-70",
        props.nested && "py-2 pl-8",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        {props.projectTitle !== null ? (
          <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
            {props.projectTitle}
          </Text>
        ) : null}
        <Text className="font-t3-medium text-base text-foreground" numberOfLines={2}>
          <Text className="text-foreground-secondary">{issueRef(props.issue)}</Text>{" "}
          {props.issue.title}
        </Text>
        {work !== null ? (
          <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
            {FEATURE_STATUS_LABELS[work.status]}
          </Text>
        ) : (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {FEATURE_STATUS_LABELS["not-started"]}
          </Text>
        )}
      </View>
      <PullRequestNumber pullRequest={work?.pullRequest ?? null} />
    </Pressable>
  );
}
/** A thread outside any feature that waits on you: a tool approval or a question. */
function NeedsYouThreadRow(props: {
  readonly shell: EnvironmentThreadShell;
  readonly projectTitle: string | null;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
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
        <Text className="font-t3-bold text-xs text-warning-foreground">
          {FEATURE_STATUS_LABELS["needs-input"]}
        </Text>
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
  /** Shown after the count in normal case, such as a milestone's progress. */
  readonly suffix?: string;
  readonly onPress?: () => void;
  readonly expanded?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={props.onPress ? "button" : "header"}
      disabled={!props.onPress}
      onPress={props.onPress}
      className="flex-row items-baseline gap-2 px-4 pb-1.5 pt-5"
    >
      <Text
        className="min-w-0 shrink font-t3-bold text-xs uppercase tracking-[1.1px] text-foreground-secondary"
        numberOfLines={1}
      >
        {props.label} ({props.count}){props.onPress ? (props.expanded ? "  ▾" : "  ▸") : ""}
      </Text>
      {props.suffix ? (
        <Text className="text-xs tabular-nums text-foreground-muted">{props.suffix}</Text>
      ) : null}
    </Pressable>
  );
}

function EmptyState(props: {
  readonly title: string;
  readonly body: string;
  readonly onStartFeature?: () => void;
}) {
  return (
    <View className="items-center gap-3 px-8 py-16">
      <Text className="font-t3-bold text-lg text-foreground">{props.title}</Text>
      <Text className="text-center text-sm text-foreground-secondary">{props.body}</Text>
      {props.onStartFeature ? (
        <Pressable
          accessibilityRole="button"
          onPress={props.onStartFeature}
          className="rounded-full bg-primary px-4 py-2.5 active:opacity-70"
        >
          <Text className="font-t3-bold text-sm text-primary-foreground">Start a feature</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const Note = (props: { readonly children: string }) => (
  <Text className="px-4 py-6 text-sm text-foreground-secondary">{props.children}</Text>
);

const itemCount = (items: ReadonlyArray<IssueTreeItem>) =>
  items.reduce((count, item) => count + 1 + item.parts.length, 0);

/**
 * The board for the projects the thread list shows, in two tabs. Work lists started features by
 * where they stand: Needs input (with chats outside a feature that wait on you), Working, Ready
 * for review, then Done folded. Issues lists open issues and todos by milestone.
 */
export function FeatureBoard(props: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** Thread shells the list shows: they place each feature and join Needs input. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** False while another screen covers the board, which then stops re-reading. */
  readonly active: boolean;
  readonly searchQuery: string;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  readonly onStartFeature: () => void;
  readonly contentContainerStyle?: StyleProp<ViewStyle>;
  readonly automaticInsets?: boolean;
}) {
  const [tab, setTab] = useState<BoardTab>("work");
  const targets = props.projects.map((project) => ({
    environmentId: project.environmentId,
    projectId: project.id,
  }));
  const board = useFeatureBoard(targets, props.active);
  // Issues are a GitHub read per project, so only the Issues tab loads them.
  const issueList = useIssueList(tab === "issues" ? targets : [], props.active && tab === "issues");
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [closedMilestonesExpanded, setClosedMilestonesExpanded] = useState(false);

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
  const searchText = props.searchQuery.trim().toLowerCase();
  const featureThreads = useMemo(() => threadsByFeature(props.threads), [props.threads]);

  const work = useMemo(() => {
    const cards = board.cards.filter((card) =>
      matchesFeatureSearch(card, props.searchQuery, [
        projectTitles.get(scopedProjectKey(card.environmentId, card.projectId)),
      ]),
    );
    // Children sit under their parent, whose group follows them too.
    const nested = nestFeatureChildren(cards, featureThreads);
    const workOf = (card: EnvironmentFeatureCard): FeatureWork => {
      const threads = nested.threads.get(featureCardKey(card)) ?? [];
      return {
        status: featureProgress(card, threads).status,
        pullRequest: featurePullRequest(card, threads),
        openThreadId: featureOpenThreadId(card, threads),
      };
    };
    return {
      groups: groupFeaturesByWork(nested.cards, nested.threads),
      workOf,
      children: (card: EnvironmentFeatureCard) => nested.children.get(featureCardKey(card)) ?? [],
    };
  }, [board.cards, featureThreads, projectTitles, props.searchQuery]);
  const needsYouThreads = useMemo(() => {
    const shells = props.threads.filter(
      (shell) =>
        !shell.feature &&
        projectTitles.has(scopedProjectKey(shell.environmentId, shell.projectId)) &&
        (!searchText || shell.title.toLowerCase().includes(searchText)),
    );
    return collectNeedsYou(shells)
      .flatMap((group) => group.items)
      .sort((a, b) => a.since.localeCompare(b.since) || a.key.localeCompare(b.key));
  }, [projectTitles, searchText, props.threads]);

  const issues = useMemo(() => {
    const words = searchText.split(/\s+/).filter(Boolean).join(" ");
    const open = issueList.issues
      .filter((issue) => issue.state === "open" && matchesIssueSearch(issue, words))
      // Hermes lacks toSorted.
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // A parent's threads include its children's, as on Work.
    const threads = nestFeatureChildren(board.cards, featureThreads).threads;
    const features = featuresByIssue(board.cards);
    return {
      groups: groupIssuesByMilestone(open, issueList.milestones),
      empty: open.length === 0,
      workOf: (issue: EnvironmentIssue) => {
        const card = featureForIssue(features, issue);
        if (card === null || card.leadThreadId === null) return null;
        const own = threads.get(featureCardKey(card)) ?? [];
        return {
          environmentId: card.environmentId,
          status: featureProgress(card, own).status,
          pullRequest: featurePullRequest(card, own),
          openThreadId: featureOpenThreadId(card, own),
        };
      },
    };
  }, [board.cards, featureThreads, issueList.issues, issueList.milestones, searchText]);

  const projectTitleFor = (environmentId: EnvironmentId, projectId: ProjectId) =>
    showProject ? (projectTitles.get(scopedProjectKey(environmentId, projectId)) ?? null) : null;
  const featureRows = (list: ReadonlyArray<EnvironmentFeatureCard>) =>
    list.map((card) => (
      <View key={featureCardKey(card)}>
        <FeatureRow
          card={card}
          projectTitle={projectTitleFor(card.environmentId, card.projectId)}
          work={work.workOf(card)}
          onOpenThread={props.onOpenThread}
        />
        {work.children(card).map((child) => (
          <FeatureRow
            key={featureCardKey(child)}
            card={child}
            projectTitle={null}
            work={work.workOf(child)}
            nested
            onOpenThread={props.onOpenThread}
          />
        ))}
      </View>
    ));
  const issueRows = (items: ReadonlyArray<IssueTreeItem>) =>
    items.map((item) => (
      <View key={issueKey(item.issue)}>
        <IssueRow
          issue={item.issue}
          projectTitle={projectTitleFor(item.issue.environmentId, item.issue.projectId)}
          work={issues.workOf(item.issue)}
          onOpenThread={props.onOpenThread}
        />
        {item.parts.map((part) => (
          <IssueRow
            key={issueKey(part)}
            issue={part}
            projectTitle={null}
            work={issues.workOf(part)}
            nested
            onOpenThread={props.onOpenThread}
          />
        ))}
        {item.closedParts > 0 ? (
          <Text className="border-b border-border py-2 pl-8 pr-4 text-xs text-foreground-muted">
            {item.closedParts} closed sub-issue{item.closedParts === 1 ? "" : "s"}
          </Text>
        ) : null}
      </View>
    ));

  let body: ReactNode;
  if (tab === "work") {
    const empty =
      work.groups.every((group) => group.cards.length === 0) && needsYouThreads.length === 0;
    if (!empty) {
      body = work.groups.map(({ group, cards }) => {
        if (group === "done") {
          if (cards.length === 0) return null;
          return (
            <View key={group}>
              <GroupHeader
                label={WORK_GROUP_LABELS.done}
                count={cards.length}
                expanded={doneExpanded}
                onPress={() => setDoneExpanded((value) => !value)}
              />
              {doneExpanded ? featureRows(cards) : null}
            </View>
          );
        }
        const threads = group === "needs-input" ? needsYouThreads : [];
        if (cards.length === 0 && threads.length === 0) return null;
        return (
          <View key={group}>
            <GroupHeader label={WORK_GROUP_LABELS[group]} count={cards.length + threads.length} />
            {featureRows(cards)}
            {threads.map((item) => (
              <NeedsYouThreadRow
                key={item.key}
                shell={item.shell}
                projectTitle={projectTitleFor(item.shell.environmentId, item.shell.projectId)}
                onOpenThread={props.onOpenThread}
              />
            ))}
          </View>
        );
      });
    } else if (board.pending) {
      body = <Note>Loading features…</Note>;
    } else if (searchText) {
      body = <Note>No matching work</Note>;
    } else {
      body = (
        <EmptyState
          title="No work in progress"
          body="Start an issue from Issues, or begin a new feature."
          onStartFeature={props.onStartFeature}
        />
      );
    }
  } else if (!issues.empty) {
    const { groups } = issues;
    body = (
      <>
        {groups.milestones.map(({ milestone, items }) => (
          <View key={issueKey(milestone)}>
            <GroupHeader
              label={milestone.title}
              count={itemCount(items)}
              suffix={`${milestone.closedIssues} of ${milestone.openIssues + milestone.closedIssues} done`}
            />
            {issueRows(items)}
          </View>
        ))}
        {groups.none.length > 0 ? (
          <View>
            <GroupHeader label="No milestone" count={itemCount(groups.none)} />
            {issueRows(groups.none)}
          </View>
        ) : null}
        {groups.closedMilestones.length > 0 ? (
          <View>
            <GroupHeader
              label="Closed milestones"
              count={groups.closedMilestones.reduce(
                (count, group) => count + itemCount(group.items),
                0,
              )}
              expanded={closedMilestonesExpanded}
              onPress={() => setClosedMilestonesExpanded((value) => !value)}
            />
            {closedMilestonesExpanded
              ? groups.closedMilestones.map((group) => (
                  <View key={group.key}>
                    <Text className="px-4 pb-1 pt-3 text-xs text-foreground-secondary">
                      {group.title}
                    </Text>
                    {issueRows(group.items)}
                  </View>
                ))
              : null}
          </View>
        ) : null}
      </>
    );
  } else if (issueList.pending) {
    body = <Note>Loading issues…</Note>;
  } else if (searchText) {
    body = <Note>No matching issues</Note>;
  } else {
    body = <EmptyState title="No open issues" body="GitHub issues and todos you add show here." />;
  }

  const errors = tab === "issues" ? [...board.errors, ...issueList.errors] : board.errors;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior={props.automaticInsets === false ? "never" : "automatic"}
      contentContainerStyle={props.contentContainerStyle}
      keyboardDismissMode="on-drag"
      className="flex-1"
    >
      <View className="px-4 pt-3">
        <SegmentedControl options={TAB_OPTIONS} selected={tab} onSelect={setTab} role="tab" />
      </View>
      {errors.map((error) => (
        <Text key={error} className="px-4 pt-3 text-sm text-danger-foreground">
          {error}
        </Text>
      ))}
      {body}
    </ScrollView>
  );
}
