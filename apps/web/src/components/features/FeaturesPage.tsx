import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  chatWorkGroup,
  featureCardKey,
  groupFeaturesByWork,
  matchesFeatureSearch,
  nestFeatureChildren,
  threadsByFeature,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";
import {
  featureForIssue,
  featuresByIssue,
  groupIssuesByMilestone,
  issueKey,
  matchesIssueSearch,
  type EnvironmentIssue,
  type EnvironmentMilestone,
} from "@t3tools/client-runtime/state/issue-board";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  boardChatThreads,
  featureRows,
  workGroupThreads,
} from "@t3tools/client-runtime/state/work-groups";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  Columns3Icon,
  InboxIcon,
  ListIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SearchXIcon,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { shortcutLabelForCommand } from "../../keybindings";
import { readLocalApi } from "../../localApi";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { useBotRailProjectKeys, useVisibleActiveLogicalBot } from "../../state/botRail";
import { useEnvironments } from "../../state/environments";
import {
  olderSettledScopes,
  useOlderSettledShelf,
  useOlderSettledShelfGrowth,
} from "../../state/olderSettledShelf";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { hasStarterRoles, useAddStarterRoles } from "../library/RoleEditor";
import { Button } from "../ui/button";
import { MainViewToggle } from "../MainViewToggle";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BoardFilterChips, BoardFilterMenu, type BoardFilterSection } from "./BoardFilters";
import { BoardTitle } from "./BoardTitle";
import { chatSince, chatTitle } from "./FeatureCard";
import {
  IssuesColumns,
  IssuesList,
  WorkColumns,
  WorkList,
  type BoardChats,
  type FeatureBoardHandlers,
  type WorkSection,
} from "./FeatureBoards";
import {
  readFeaturesPagePreferences,
  updateFeaturesPagePreferences,
  type BoardTab,
  type FeaturesPagePreferences,
} from "./featuresPagePreferences";
import { resolveFeaturesShortcut } from "./featuresShortcuts";
import { pickWorkflow, useBoardWorkflows, useStartTodo, useStartingTodos } from "./startFromBoard";
import { closeTodoAsCompleted } from "./todoState";
import { useFeatureActions } from "./useFeatureActions";
import { useFeatureBoard, useFeatureEnvironmentIds } from "./useFeatureBoard";
import { useIssueBoard } from "./useIssueBoard";
import { useStartFeatureDraft } from "./TodoDetail";
import { openNewTodoDialog, openTodo } from "./todoDialogs";

export interface FeaturesSearch {
  readonly q?: string;
  /** `environmentId:projectId`; absent is All projects. */
  readonly project?: string;
  /** The `issueKey` of the milestone the board is narrowed to. */
  readonly milestone?: string;
}

const projectKey = (project: { readonly environmentId: EnvironmentId; readonly id: ProjectId }) =>
  `${project.environmentId}:${project.id}`;

function toggled<Value>(current: ReadonlySet<Value>, value: Value, on: boolean): Set<Value> {
  const next = new Set(current);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

/**
 * The board: the main area's Board view, flipped from the sidebar's List / Board toggle. Work
 * holds features and chats by where they stand; Issues holds the backlog by milestone. Both
 * share the project scope, filters and search.
 */
export function FeaturesPage(props: {
  readonly search: FeaturesSearch;
  /** `undefined` removes a key. */
  readonly onSearchChange: (patch: {
    readonly [Key in keyof FeaturesSearch]?: FeaturesSearch[Key] | undefined;
  }) => void;
}) {
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [preferences, setPreferences] = useState(readFeaturesPagePreferences);
  const [query, setQuery] = useState(props.search.q ?? "");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [labelFilters, setLabelFilters] = useState<ReadonlySet<string>>(new Set());
  const phone = useMediaQuery("max-sm");

  // Projects on servers that run features; the scope picker lists only these.
  const featureEnvironmentIds = useFeatureEnvironmentIds();
  const allProjects = useProjects();
  // The board follows the bot rail like the sidebar does.
  const railProjectKeys = useBotRailProjectKeys();
  const railBot = useVisibleActiveLogicalBot();
  const projects = allProjects
    .filter(
      (project) =>
        featureEnvironmentIds.has(project.environmentId) &&
        (railProjectKeys === null || railProjectKeys.has(projectKey(project))),
    )
    .toSorted((a, b) => a.title.localeCompare(b.title));
  const projectByKey = new Map(projects.map((project) => [projectKey(project), project]));
  // The board's project scope is the sidebar's, so the board opens on the project in view.
  const sidebarScopeKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
  const setSidebarScopeKeys = useUiStateStore((store) => store.setSidebarProjectScopeKeys);
  const projectGroups = useSettingsProjectGroups();
  const sidebarGroup =
    sidebarScopeKeys.length === 1
      ? projectGroups.find((group) => group.projectKey === sidebarScopeKeys[0])
      : undefined;
  const sidebarProject =
    sidebarGroup?.memberProjectRefs
      .map((ref) => projectByKey.get(`${ref.environmentId}:${ref.projectId}`))
      .find((project) => project !== undefined) ?? null;
  const scopedProject = props.search.project
    ? (projectByKey.get(props.search.project) ?? null)
    : sidebarProject;
  const scopeToProject = (project: EnvironmentProject | null) => {
    const group = project
      ? projectGroups.find((candidate) =>
          candidate.memberProjectRefs.some(
            (ref) => ref.environmentId === project.environmentId && ref.projectId === project.id,
          ),
        )
      : undefined;
    setSidebarScopeKeys(group ? [group.projectKey] : []);
    props.onSearchChange({ project: undefined });
  };
  const targets = (scopedProject ? [scopedProject] : projects).map((project) => ({
    environmentId: project.environmentId,
    projectId: project.id,
  }));
  const board = useFeatureBoard(targets);
  const issueBoard = useIssueBoard(targets, true);
  const projectFor = (item: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => projectByKey.get(`${item.environmentId}:${item.projectId}`) ?? null;
  const { environments } = useEnvironments();
  const machineName = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  // A one-project board shows where each row runs; across projects, which project it is.
  const showProject = scopedProject === null && projects.length > 1;
  const placeFor = (item: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => ({
    project: projectFor(item),
    machine: machineName.get(item.environmentId) ?? null,
    showProject,
  });

  const updatePreferences = (
    patch: (current: FeaturesPagePreferences) => Partial<FeaturesPagePreferences>,
  ) => setPreferences(updateFeaturesPagePreferences(patch));
  // Each project remembers its tab, and each tab its layout. A phone always lists.
  const scopeKey = scopedProject ? projectKey(scopedProject) : "all";
  const tab: BoardTab = preferences.tabByProject?.[scopeKey] ?? "work";
  const setTab = (next: BoardTab) =>
    updatePreferences((current) => ({
      tabByProject: { ...current.tabByProject, [scopeKey]: next },
    }));
  const chosenLayout = preferences.layoutByTab?.[tab] ?? preferences.featureLayout ?? "list";
  const layout = phone ? "list" : chosenLayout;
  const setLayout = (next: "list" | "board") =>
    updatePreferences((current) => ({ layoutByTab: { ...current.layoutByTab, [tab]: next } }));

  // A milestone or label narrows both tabs: Issues to its issues, Work to the features on them.
  const issueFeatures = featuresByIssue(board.cards);
  const featureFor = (issue: EnvironmentIssue) => featureForIssue(issueFeatures, issue);
  const milestoneFilter = props.search.milestone ?? null;
  const inMilestone = (issue: EnvironmentIssue) =>
    milestoneFilter === null ||
    (issue.milestone !== null &&
      issueKey({ ...issue, number: issue.milestone.number, ticketId: null }) === milestoneFilter);
  const hasLabel = (issue: EnvironmentIssue) =>
    labelFilters.size === 0 || issue.labels.some((label) => labelFilters.has(label.name));
  const issueFiltersOn = milestoneFilter !== null || labelFilters.size > 0;
  const filteredFeatureKeys = new Set(
    issueBoard.issues.flatMap((issue) => {
      const feature = inMilestone(issue) && hasLabel(issue) ? featureFor(issue) : null;
      return feature ? [featureCardKey(feature)] : [];
    }),
  );
  /** Each feature's issue, for the jump from its `#issue` to its row in Issues. */
  const issueOfFeature = new Map(
    issueBoard.issues.flatMap((issue) => {
      const feature = featureFor(issue);
      return feature ? [[featureCardKey(feature), issue] as const] : [];
    }),
  );

  const searchWords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visibleCards = board.cards.filter(
    (card) =>
      matchesFeatureSearch(card, query, [projectFor(card)?.title]) &&
      (!issueFiltersOn || filteredFeatureKeys.has(featureCardKey(card))),
  );
  const openIssues = issueBoard.issues
    .filter(
      (issue) =>
        issue.state === "open" &&
        inMilestone(issue) &&
        hasLabel(issue) &&
        matchesIssueSearch(issue, searchWords.join(" ")),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const issueGroups = groupIssuesByMilestone(openIssues, issueBoard.milestones);
  // A feature nobody started that has no issue of its own sits with the backlog.
  const unstarted = visibleCards.filter(
    (card) => card.leadThreadId === null && card.status === "open" && card.issue === null,
  );
  const starting = useStartingTodos();

  // Work shows what the thread list shows. A feature sits where its row does: settled, snoozed or
  // neither. A started one with no row (its threads archived, or settled long ago and not loaded)
  // has no row either; Settled counts those threads until it loads them.
  const { settleThread, unsettleThread, snoozeThread, unsnoozeThread } = useThreadActions();
  const shells = useQuietThreadShells();
  const rows = featureRows(shells);
  const featureThreads = threadsByFeature(shells);
  const nowMinute = useNowMinute();
  const rowFor = (card: EnvironmentFeatureCard) => {
    const group = rows.get(featureCardKey(card));
    return group ? workGroupThreads(group) : [];
  };
  const isSettled = (card: EnvironmentFeatureCard) =>
    rowFor(card)[0]?.settledOverride === "settled";
  const isSnoozed = (card: EnvironmentFeatureCard) => {
    const primary = rowFor(card)[0];
    return primary !== undefined && effectiveSnoozed(primary, { now: `${nowMinute}:00.000Z` });
  };
  // Children sit under their parent, which then stands for them all, but only on the same
  // shelf: settling or snoozing a parent mustn't hide a child that still needs you.
  const shelfOf = (card: EnvironmentFeatureCard) =>
    isSettled(card) ? "settled" : isSnoozed(card) ? "snoozed" : "open";
  const started = visibleCards.filter((card) => rowFor(card).length > 0);
  const shelves = (["open", "snoozed", "settled"] as const).map((shelf) =>
    nestFeatureChildren(
      started.filter((card) => shelfOf(card) === shelf),
      featureThreads,
    ),
  );
  const listedCards = shelves.flatMap((shelf) => shelf.cards);
  const childCards = new Map(shelves.flatMap((shelf) => [...shelf.children]));
  const nestedThreads = new Map(featureThreads);
  for (const shelf of shelves)
    for (const key of shelf.children.keys()) nestedThreads.set(key, shelf.threads.get(key) ?? []);
  const threadsFor = (card: EnvironmentFeatureCard) =>
    nestedThreads.get(featureCardKey(card)) ?? [];
  const snoozedUntil = (card: EnvironmentFeatureCard) => rowFor(card)[0]?.snoozedUntil ?? "";
  const settledCards = listedCards
    .filter(isSettled)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const snoozedCards = listedCards
    .filter((card) => !isSettled(card) && isSnoozed(card))
    .toSorted((a, b) => snoozedUntil(a).localeCompare(snoozedUntil(b)));
  const groups = groupFeaturesByWork(
    listedCards.filter((card) => !isSettled(card) && !isSnoozed(card)),
    nestedThreads,
  );

  // Settled counts the board's older settled threads this client hasn't loaded, as the sidebar's
  // shelf does, and opening it loads them. Only unfiltered: the server counts can't be searched.
  const [settledExpanded, setSettledExpanded] = useState(false);
  const scopeKeys = new Set(targets.map((target) => `${target.environmentId}:${target.projectId}`));
  const olderSettled = useOlderSettledShelf({
    scopes: olderSettledScopes(
      [...new Set(targets.map((target) => target.environmentId))],
      scopeKeys,
    ),
    expanded: settledExpanded,
    // The board pages its own rows, so an open shelf reads every older page.
    visibleCount: Number.MAX_SAFE_INTEGER,
  });
  const scopeShells = shells.filter(
    (shell) =>
      shell.archivedAt === null && scopeKeys.has(`${shell.environmentId}:${shell.projectId}`),
  );
  useOlderSettledShelfGrowth(
    olderSettled,
    scopeShells.filter(
      (shell) => shell.settledOverride === "settled" && olderSettled.isListed(shell),
    ),
  );
  const unfiltered = !issueFiltersOn && !query.trim();
  const settledShelf = {
    expanded: settledExpanded,
    onExpandedChange: setSettledExpanded,
    unloaded: unfiltered ? olderSettled.unloadedCount(scopeShells) : 0,
  };

  // Chats sit beside features where their PR and sidebar status put them. They have no
  // milestone or label, so those filters leave only features.
  const chatSections = new Map<WorkSection, EnvironmentThreadShell[]>();
  for (const shell of issueFiltersOn ? [] : boardChatThreads(shells)) {
    const project = projectFor(shell);
    if (!project || (scopedProject !== null && project !== scopedProject)) continue;
    const haystack = [chatTitle(shell), shell.branch, project.title].join(" ").toLowerCase();
    if (!searchWords.every((word) => haystack.includes(word))) continue;
    const section: WorkSection =
      shell.settledOverride === "settled"
        ? "settled"
        : effectiveSnoozed(shell, { now: `${nowMinute}:00.000Z` })
          ? "snoozed"
          : chatWorkGroup(shell);
    chatSections.set(section, [...(chatSections.get(section) ?? []), shell]);
  }
  const chatOrder: Record<
    WorkSection,
    (a: EnvironmentThreadShell, b: EnvironmentThreadShell) => number
  > = {
    // The longest wait first, as for features.
    "needs-input": (a, b) =>
      (a.runtime?.updatedAt ?? a.updatedAt).localeCompare(b.runtime?.updatedAt ?? b.updatedAt),
    working: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    review: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    done: (a, b) => chatSince(b).localeCompare(chatSince(a)),
    snoozed: (a, b) => (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? ""),
    settled: (a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""),
  };
  const chats: BoardChats = Object.fromEntries(
    [...chatSections].map(([section, list]) => [section, list.toSorted(chatOrder[section])]),
  );
  const workItems = { groups, snoozed: snoozedCards, settled: settledCards, chats };
  const workCount = groups.reduce(
    (count, group) => count + group.cards.length + (chats[group.group]?.length ?? 0),
    0,
  );
  const needsInput =
    (groups.find((group) => group.group === "needs-input")?.cards.length ?? 0) +
    (chats["needs-input"]?.length ?? 0);
  const shelvedCount =
    snoozedCards.length +
    settledCards.length +
    (chats.snoozed?.length ?? 0) +
    (chats.settled?.length ?? 0) +
    settledShelf.unloaded;
  const issueCount = openIssues.length + unstarted.length;

  const reportParkFailure = (title: string) => (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };
  const parkChat = (title: string, result: Promise<AtomCommandResult<unknown, unknown>>) =>
    void result.then(reportParkFailure(title));
  const snooze = (card: EnvironmentFeatureCard, until: string) => {
    for (const thread of rowFor(card)) {
      void snoozeThread(scopeThreadRef(thread.environmentId, thread.id), until).then(
        reportParkFailure("Failed to snooze feature"),
      );
    }
  };
  const wake = (card: EnvironmentFeatureCard) => {
    for (const thread of rowFor(card)) {
      if (thread.snoozedUntil === null) continue;
      void unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id)).then(
        reportParkFailure("Failed to wake feature"),
      );
    }
  };
  const toggleShelf = (card: EnvironmentFeatureCard) => {
    const settled = isSettled(card);
    for (const thread of rowFor(card)) {
      if ((thread.settledOverride === "settled") !== settled) continue;
      const ref = scopeThreadRef(thread.environmentId, thread.id);
      void (settled ? unsettleThread(ref) : settleThread(ref)).then(
        reportParkFailure(settled ? "Failed to un-settle feature" : "Failed to settle feature"),
      );
    }
  };

  // A jump between tabs lands on the row it names once that tab has rendered it.
  const jumpTo = useRef<string | null>(null);
  const [revealedRow, setRevealedRow] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scrolls to and focuses the row a jump names once the other tab has rendered it.
  useEffect(() => {
    const key = jumpTo.current;
    if (key === null) return;
    const row = document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`);
    if (!row) return;
    jumpTo.current = null;
    row.scrollIntoView({ block: "center" });
    row.querySelector<HTMLElement>("[data-card-open]")?.focus({ preventScroll: true });
  });
  const jump = (target: BoardTab, key: string) => {
    jumpTo.current = key;
    setRevealedRow(key);
    updatePreferences((current) => ({
      layoutByTab: { ...current.layoutByTab, [target]: "list" },
      tabByProject: { ...current.tabByProject, [scopeKey]: target },
    }));
  };

  const actions = useFeatureActions();
  const startFeatureDraft = useStartFeatureDraft();
  const startTodo = useStartTodo();
  // Workflows belong to an environment; the board reads the one New starts in.
  const newFeatureProject: EnvironmentProject | null = scopedProject ?? projects[0] ?? null;
  const workflowsByEnvironment = useBoardWorkflows(targets.map((target) => target.environmentId));
  const workflowsFor = (owner: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => ({
    workflows: workflowsByEnvironment.get(owner.environmentId) ?? [],
    workflow: pickWorkflow(workflowsByEnvironment.get(owner.environmentId) ?? [], owner),
  });
  const description = (issue: EnvironmentIssue) =>
    issueBoard.tickets.get(issueKey(issue))?.description;
  const handlers: FeatureBoardHandlers = {
    projectFor,
    placeFor,
    threadsFor,
    childrenFor: (card) => childCards.get(featureCardKey(card)) ?? [],
    onOpen: (card) => {
      if (!actions.openCard(card, threadsFor(card)))
        toastManager.add({ type: "info", title: "Start this feature to open its lead" });
    },
    onMenu: (card: EnvironmentFeatureCard, event: MouseEvent) =>
      void actions.showMenu(card, { x: event.clientX, y: event.clientY }),
    onAction: (card, action) => void actions.run(card, action),
    onShelf: toggleShelf,
    canShelf: (card) => rowFor(card).length > 0,
    onWake: wake,
    onSnooze: snooze,
    onDrop: (card) => toggleShelf(card),
    onShowIssue: (card) => {
      const issue = issueOfFeature.get(featureCardKey(card));
      if (issue) jump("issues", issueKey(issue));
      else if (card.issue)
        openTodo({
          environmentId: card.environmentId,
          projectId: card.projectId,
          ...(card.issue.ticketId
            ? { ticketId: card.issue.ticketId }
            : { number: card.issue.number }),
        });
    },
    onShowWork: (card) => jump("work", featureCardKey(card)),
    onOpenTodo: (issue) =>
      openTodo(
        issue.ticketId
          ? {
              environmentId: issue.environmentId,
              projectId: issue.projectId,
              ticketId: issue.ticketId,
            }
          : {
              environmentId: issue.environmentId,
              projectId: issue.projectId,
              number: issue.number,
            },
      ),
    onStartTodo: (issue, workflow) => {
      const feature = featureFor(issue);
      void startTodo(
        issue,
        workflow ?? workflowsFor(issue).workflow,
        description(issue),
        feature?.leadThreadId === null && feature.status === "open" ? feature : undefined,
      );
    },
    onEditBrief: (issue) =>
      startFeatureDraft(
        { environmentId: issue.environmentId, projectId: issue.projectId },
        { issue, description: description(issue) },
      ),
    onCloseTodo: (issue) => void closeTodoAsCompleted(issue),
    onOpenExternal: (url) => void readLocalApi()?.shell.openExternal(url),
    workflowsFor,
    featureFor,
    onOpenChat: (shell) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: shell.environmentId, threadId: shell.id },
      }),
    onChatShelf: (shell) => {
      const ref = scopeThreadRef(shell.environmentId, shell.id);
      if (shell.settledOverride === "settled")
        parkChat("Failed to un-settle thread", unsettleThread(ref));
      else parkChat("Failed to settle thread", settleThread(ref));
    },
    onChatWake: (shell) =>
      parkChat(
        "Failed to wake thread",
        unsnoozeThread(scopeThreadRef(shell.environmentId, shell.id)),
      ),
    onChatSnooze: (shell, until) =>
      parkChat(
        "Failed to snooze thread",
        snoozeThread(scopeThreadRef(shell.environmentId, shell.id), until),
      ),
    onNewTodo: (milestone) => newTodo(milestone ? { milestone } : {}),
  };

  const newTodo = (
    options: { readonly milestone?: EnvironmentMilestone; readonly start?: boolean } = {},
  ) => {
    const { milestone, start } = options;
    const narrowed =
      milestone ?? issueBoard.milestones.find((m) => issueKey(m) === milestoneFilter);
    const project = milestone ? projectFor(milestone) : newFeatureProject;
    openNewTodoDialog({
      ...(project
        ? { project: { environmentId: project.environmentId, projectId: project.id } }
        : {}),
      // A board narrowed to a milestone, or a milestone's +, files new issues in it.
      ...(narrowed &&
      project &&
      narrowed.environmentId === project.environmentId &&
      narrowed.projectId === project.id
        ? { milestone: narrowed.number, kind: "issue" as const }
        : {}),
      ...(start ? { start: true } : {}),
    });
  };
  // New feature files a todo and starts it, so its work always has a row in Issues too.
  const startNewFeature = () => newTodo({ start: true });
  const newTodoShortcut = shortcutLabelForCommand(keybindings, "features.newTodo", {
    context: { featuresPageOpen: true },
  });
  const tabShortcut = (target: BoardTab) =>
    shortcutLabelForCommand(
      keybindings,
      target === "work" ? "features.workTab" : "features.issuesTab",
      { context: { featuresPageOpen: true } },
    );

  /** The open, unstarted todo whose row has focus, for S. */
  const focusedTodo = () => {
    const key = document.activeElement?.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey;
    return key ? openIssues.find((issue) => issueKey(issue) === key) : undefined;
  };

  const onPageKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      isCommandPaletteOpen() ||
      isModelPickerOpen()
    )
      return;
    const command = resolveFeaturesShortcut(event, keybindings);
    if (!command) return;
    if (command === "features.startTodo") {
      const issue = tab === "issues" ? focusedTodo() : undefined;
      const feature = issue ? featureFor(issue) : null;
      if (!issue || (feature && feature.leadThreadId !== null)) return;
      event.preventDefault();
      handlers.onStartTodo(issue);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (command === "features.search") {
      setSearchOpen(true);
      searchInputRef.current?.focus();
    } else if (command === "features.workTab") setTab("work");
    else if (command === "features.issuesTab") setTab("issues");
    else newTodo();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribes the page's shortcuts to window keydown while it is mounted.
  useEffect(() => {
    window.addEventListener("keydown", onPageKeyDown, true);
    return () => window.removeEventListener("keydown", onPageKeyDown, true);
  }, []);

  // Keep the URL's query in step with the field, without a history entry per keystroke.
  // A URL change that isn't our own write (back, a link) replaces the field instead.
  const { onSearchChange } = props;
  const urlQuery = props.search.q ?? "";
  const [writtenQuery, setWrittenQuery] = useState(urlQuery);
  const [seenUrlQuery, setSeenUrlQuery] = useState(urlQuery);
  if (urlQuery !== seenUrlQuery) {
    setSeenUrlQuery(urlQuery);
    if (urlQuery !== writtenQuery) {
      setWrittenQuery(urlQuery);
      setQuery(urlQuery);
    }
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Debounces the field into the URL; the timer is cleared on the next keystroke or unmount.
  useEffect(() => {
    if (urlQuery === query) return;
    const handle = window.setTimeout(() => {
      setWrittenQuery(query);
      onSearchChange({ q: query || undefined });
    }, 300);
    return () => window.clearTimeout(handle);
  }, [onSearchChange, query, urlQuery]);

  const clearFilters = () => {
    setLabelFilters(new Set());
    setSidebarScopeKeys([]);
    props.onSearchChange({ project: undefined, milestone: undefined });
  };
  const clearEverything = () => {
    clearFilters();
    setQuery("");
    setSearchOpen(false);
  };
  const issueLabels = [
    ...new Set(issueBoard.issues.flatMap((issue) => issue.labels.map((label) => label.name))),
  ]
    .toSorted((a, b) => a.localeCompare(b))
    .slice(0, 30);
  const filterSections: ReadonlyArray<BoardFilterSection> = [
    ...(projects.length > 1 || scopedProject
      ? [
          {
            label: "Project",
            options: projects.map((project) => ({
              value: projectKey(project),
              label: project.title,
              checked: project === scopedProject,
            })),
            onChange: (value: string, checked: boolean) =>
              scopeToProject(checked ? (projectByKey.get(value) ?? null) : null),
          },
        ]
      : []),
    ...(issueBoard.milestones.length > 0 || milestoneFilter
      ? [
          {
            label: "Milestone",
            options: issueBoard.milestones.map((milestone) => ({
              value: issueKey(milestone),
              label: showProject
                ? `${projectFor(milestone)?.title ?? "Project"} · ${milestone.title}`
                : milestone.title,
              checked: issueKey(milestone) === milestoneFilter,
            })),
            onChange: (value: string, checked: boolean) =>
              props.onSearchChange({ milestone: checked ? value : undefined }),
          },
        ]
      : []),
    ...(issueLabels.length > 0
      ? [
          {
            label: "Label",
            options: issueLabels.map((label) => ({
              value: label,
              label,
              checked: labelFilters.has(label),
            })),
            onChange: (value: string, checked: boolean) =>
              setLabelFilters((current) => toggled(current, value, checked)),
          },
        ]
      : []),
  ];

  const tabToggle = (target: BoardTab, label: string, count: number, dot: boolean) => {
    const shortcut = tabShortcut(target);
    return (
      <Tooltip>
        <TooltipTrigger render={<Toggle value={target} aria-label={`${label}, ${count}`} />}>
          {label}
          <span className="text-muted-foreground tabular-nums">{count}</span>
          {dot ? (
            <span aria-label="Needs input" className="size-1.5 rounded-full bg-warning" />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {label}
          {shortcut ? <Kbd className="ms-2">{shortcut}</Kbd> : null}
        </TooltipPopup>
      </Tooltip>
    );
  };

  const tabsRow = (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/70 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)">
      <ToggleGroup
        aria-label="Board tab"
        variant="pill"
        size="sm"
        value={[tab]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "work" || next === "issues") setTab(next);
        }}
      >
        {tabToggle("work", "Work", workCount, tab === "issues" && needsInput > 0)}
        {tabToggle("issues", "Issues", issueCount, false)}
      </ToggleGroup>
      <div className="ms-auto flex min-w-0 items-center gap-1">
        <IssueRefreshButton
          readAt={issueBoard.readAt}
          refreshing={issueBoard.refreshing}
          onRefresh={issueBoard.refresh}
        />
        {searchOpen || query ? (
          <InputGroup className="w-40 md:w-60">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchInputRef}
              type="search"
              autoFocus
              aria-label="Search the board"
              placeholder="Search or #number"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onBlur={() => {
                if (!query) setSearchOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                setQuery("");
                setSearchOpen(false);
              }}
            />
          </InputGroup>
        ) : (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Search the board"
            title="Search (/)"
            onClick={() => setSearchOpen(true)}
          >
            <SearchIcon aria-hidden />
          </Button>
        )}
        <BoardFilterMenu sections={filterSections} onClear={clearFilters} />
        <ToggleGroup
          aria-label="Layout"
          variant="segmented"
          className="ms-1 max-sm:hidden"
          value={[chosenLayout]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "list" || next === "board") setLayout(next);
          }}
        >
          <Toggle value="list" aria-label="List">
            <ListIcon aria-hidden />
          </Toggle>
          <Toggle value="board" aria-label="Board">
            <Columns3Icon aria-hidden />
          </Toggle>
        </ToggleGroup>
      </div>
    </div>
  );

  const filtered = issueFiltersOn || query.trim() !== "";
  const loading = tab === "work" ? board.pending && board.cards.length === 0 : issueBoard.pending;
  const empty =
    tab === "work"
      ? workCount === 0 && shelvedCount === 0 && !loading
      : issueCount === 0 && !issueBoard.pending;
  const issueItems = { groups: issueGroups, unstarted, pending: issueBoard.pending, starting };

  let body: ReactNode;
  // The columns fill the page and scroll each column; everything else scrolls the page.
  let lanes = false;
  if (projects.length === 0) {
    body = (
      <p className="py-10 text-center text-sm text-muted-foreground">
        {railBot !== null &&
        allProjects.some((project) => featureEnvironmentIds.has(project.environmentId))
          ? `${railBot.name} owns no projects. Pick Projects in the rail to see every project.`
          : "Connect an environment that runs features to see them."}
      </p>
    );
  } else if (empty && filtered) {
    body = (
      <EmptyState
        icon={SearchXIcon}
        title="Nothing matches"
        description="No rows match the search and filters."
        actions={
          <Button variant="outline" size="sm" onClick={clearEverything}>
            Clear filters
          </Button>
        }
      />
    );
  } else if (empty && tab === "work") {
    body = (
      <EmptyState
        icon={InboxIcon}
        title="No work in progress"
        description="Start an issue from Issues, or begin a new feature."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setTab("issues")}>
              Go to Issues
              {tabShortcut("issues") ? <Kbd>{tabShortcut("issues")}</Kbd> : null}
            </Button>
            {newFeatureProject ? (
              <StartFirstFeatureButton
                environmentId={newFeatureProject.environmentId}
                onReady={startNewFeature}
              />
            ) : null}
          </>
        }
      />
    );
  } else if (empty) {
    body = (
      <EmptyState
        icon={CheckIcon}
        title="No open issues"
        description="GitHub issues and todos you add show here."
        actions={
          <Button size="sm" onClick={() => newTodo()} disabled={!newFeatureProject}>
            <PlusIcon aria-hidden />
            New todo
            {newTodoShortcut ? <Kbd>{newTodoShortcut}</Kbd> : null}
          </Button>
        }
      />
    );
  } else if (loading && tab === "work") {
    body = (
      <div className="flex flex-col gap-2 py-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-6 w-2/3" />
        ))}
      </div>
    );
  } else {
    lanes = layout === "board";
    body =
      tab === "work" ? (
        layout === "board" ? (
          <WorkColumns items={workItems} settledShelf={settledShelf} handlers={handlers} />
        ) : (
          <WorkList
            revealedRow={revealedRow}
            items={workItems}
            settledShelf={settledShelf}
            handlers={handlers}
          />
        )
      ) : layout === "board" ? (
        <IssuesColumns items={issueItems} handlers={handlers} />
      ) : (
        <IssuesList revealedRow={revealedRow} items={issueItems} handlers={handlers} />
      );
  }

  const errors = [...board.errors, ...issueBoard.errors];
  const content = (
    <>
      <BoardFilterChips sections={filterSections} onClear={clearFilters} />
      {errors.length > 0 ? (
        <p role="alert" className="text-sm text-destructive">
          {errors[0]}
        </p>
      ) : null}
      {tab === "issues" && issueBoard.truncated ? (
        <p className="text-xs text-muted-foreground">
          Issues shows the 100 most recently updated open issues per project. Search narrows them.
        </p>
      ) : null}
      {body}
    </>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border/70">
          <BoardTitle />
          <div className="ms-auto flex min-w-0 items-center gap-1">
            <MainViewToggle />
            <Menu>
              <MenuTrigger
                render={
                  <Button size="sm" disabled={!newFeatureProject}>
                    <PlusIcon aria-hidden />
                    New
                  </Button>
                }
              />
              <MenuPopup align="end">
                <MenuItem onClick={() => newTodo()}>
                  New todo
                  {newTodoShortcut ? <MenuShortcut>{newTodoShortcut}</MenuShortcut> : null}
                </MenuItem>
                <MenuItem onClick={startNewFeature}>New feature</MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        </WorkspacePageHeader>
        {tabsRow}
        {lanes ? (
          <WorkspacePageContainer width="full" className="min-h-0 flex-1 gap-3 pt-3 pb-3">
            {content}
          </WorkspacePageContainer>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer width="full" className="gap-3 pt-0">
              {content}
            </WorkspacePageContainer>
          </ScrollArea>
        )}
      </div>
    </SidebarInset>
  );
}

function EmptyState(props: {
  readonly icon: typeof InboxIcon;
  readonly title: string;
  readonly description: string;
  readonly actions: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-1.5 py-16 text-center">
      <props.icon aria-hidden className="size-5 text-muted-foreground/70" />
      <h2 className="text-sm font-medium">{props.title}</h2>
      <p className="text-xs text-muted-foreground">{props.description}</p>
      <div className="mt-3 flex gap-2">{props.actions}</div>
    </div>
  );
}

/** The first feature's crew comes from the starter roles, so this adds them if missing. */
function StartFirstFeatureButton(props: {
  readonly environmentId: EnvironmentId;
  readonly onReady: () => void;
}) {
  const roles = useEnvironmentQuery(
    rolesEnvironment.roles({ environmentId: props.environmentId, input: {} }),
  );
  const starterRoles = useAddStarterRoles(props.environmentId);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (hasStarterRoles(roles.data ?? [])) return props.onReady();
    if (!starterRoles.ready) {
      toastManager.add({
        type: "error",
        title: "Choose a default model first",
        description: "The starter roles run on it. Set one in Settings, then try again.",
      });
      return;
    }
    setBusy(true);
    const added = await starterRoles.add();
    setBusy(false);
    if (added) props.onReady();
  };
  return (
    <Button size="sm" onClick={() => void start()} disabled={busy}>
      <PlusIcon aria-hidden />
      New feature
    </Button>
  );
}

/** Refresh with how fresh the board is; its own component so the ticking clock repaints only it. */
function IssueRefreshButton(props: {
  readAt: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const relative = useRelativeTimeState(props.readAt);
  const synced =
    relative.status === "relative"
      ? `Synced ${relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value}`
      : null;
  return (
    <>
      {synced ? (
        <span className="hidden whitespace-nowrap ps-1 text-xs text-muted-foreground tabular-nums md:inline">
          {synced}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Refresh issues"
        title={synced ? `Refresh from GitHub · ${synced.toLowerCase()}` : "Refresh from GitHub"}
        disabled={props.refreshing}
        onClick={props.onRefresh}
      >
        <RefreshCwIcon aria-hidden />
      </Button>
    </>
  );
}
