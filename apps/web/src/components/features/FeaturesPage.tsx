import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  buildFeatureStageBoard,
  collectNeedsYou,
  featureQueuePositions,
  groupFeaturesByPhase,
  matchesFeatureSearch,
  mostUsedWorkflowId,
  parseFeatureSearch,
  type EnvironmentFeatureCard,
  type NeedsYouItem,
} from "@t3tools/client-runtime/state/crew-board";
import {
  ISSUE_LANE_LABELS,
  featureForIssue,
  featuresByIssue,
  groupIssues,
  issueLane,
  matchesIssueSearch,
  issueKey,
  type EnvironmentIssue,
  type IssueLane,
} from "@t3tools/client-runtime/state/issue-board";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleDotIcon,
  LayersIcon,
  MilestoneIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type MouseEvent } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { shortcutLabelForCommand } from "../../keybindings";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { useBotRailProjectKeys } from "../../state/botRail";
import { useProjects } from "../../state/entities";
import { needsYouThreadsAtom } from "../../state/needsYou";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { workflowsEnvironment } from "../../state/workflows";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { FeatureDisplayMenu, IssueDisplayMenu } from "./BoardDisplayMenu";
import { BoardFilterChips, BoardFilterMenu, type BoardFilterSection } from "./BoardFilters";
import { featureStatus } from "./FeatureCard";
import {
  FeaturePhaseBoard,
  FeaturePhaseList,
  FeatureStageBoardView,
  type FeatureBoardHandlers,
} from "./FeatureBoards";
import { NeedsYouListView } from "./FeatureLists";
import { FeatureNoteDialog } from "./FeatureNoteDialog";
import {
  IssueBoardView,
  IssueListView,
  IssueSuggestions,
  MilestonesView,
  type IssueViewHandlers,
} from "./IssueViews";
import {
  ALL_PROJECTS_SCOPE,
  DEFAULT_ISSUE_DISPLAY,
  DEFAULT_SCOPE_PREFERENCES,
  readFeaturesPagePreferences,
  saveFeaturesPagePreferences,
  type FeaturesPagePreferences,
  type FeaturesScopePreferences,
  type IssueDisplayPreferences,
} from "./featuresPagePreferences";
import { resolveFeaturesShortcut } from "./featuresShortcuts";
import { useFeatureActions, type FeatureNoteRequest } from "./useFeatureActions";
import { useFeatureBoard, useWorkflowEnvironmentIds } from "./useFeatureBoard";
import { useIssueBoard } from "./useIssueBoard";
import { useStartFeatureFromTodo } from "./TodoDetail";
import { openNewTodoDialog, openTodo } from "./todoDialogs";

export interface FeaturesSearch {
  readonly needsYou?: boolean;
  readonly q?: string;
  /** `environmentId:projectId`; absent is All projects. */
  readonly project?: string;
  /** Absent is Features. */
  readonly view?: "issues" | "milestones";
  /** The `issueKey` of the milestone the Issues view is narrowed to. */
  readonly milestone?: string;
}

type BoardView = "features" | "issues" | "milestones";

const TODO_SOURCES = { ticket: "Tickets", github: "GitHub issues" } as const;
type TodoSource = keyof typeof TODO_SOURCES;

const ISSUE_LANES = Object.keys(ISSUE_LANE_LABELS) as IssueLane[];

const projectKey = (project: { readonly environmentId: EnvironmentId; readonly id: ProjectId }) =>
  `${project.environmentId}:${project.id}`;

const STATE_FILTERS = [
  "working",
  "queued",
  "approval",
  "input",
  "your-call",
  "failed",
  "paused",
  "cancelled",
  "done",
] as const;
type StateFilter = (typeof STATE_FILTERS)[number] | "not-started";

function toggled<Value>(current: ReadonlySet<Value>, value: Value, on: boolean): Set<Value> {
  const next = new Set(current);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

/** The card state a filter matches; unstarted features are their own filter. */
const cardFilterState = (card: EnvironmentFeatureCard): StateFilter =>
  !card.started && card.state !== "done" && card.state !== "cancelled" ? "not-started" : card.state;

/** The board: the main area's Board view, flipped from the sidebar's List / Board toggle. */
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
  const [stateFilters, setStateFilters] = useState<ReadonlySet<StateFilter>>(new Set());
  const [gateFilter, setGateFilter] = useState<string | null>(null);
  const [noteRequest, setNoteRequest] = useState<FeatureNoteRequest | null>(null);
  const view: BoardView = props.search.view ?? "features";
  const isFeatures = view === "features";
  const needsYou = isFeatures && props.search.needsYou === true;
  const [laneFilters, setLaneFilters] = useState<ReadonlySet<IssueLane>>(new Set());
  const [labelFilters, setLabelFilters] = useState<ReadonlySet<string>>(new Set());
  const [sourceFilters, setSourceFilters] = useState<ReadonlySet<TodoSource>>(new Set());

  // Projects on servers that run workflows; the scope picker lists only these.
  const workflowEnvironmentIds = useWorkflowEnvironmentIds();
  const allProjects = useProjects();
  // The board follows the bot rail like the sidebar does.
  const railProjectKeys = useBotRailProjectKeys();
  const projects = allProjects
    .filter(
      (project) =>
        workflowEnvironmentIds.has(project.environmentId) &&
        (railProjectKeys === null || railProjectKeys.has(projectKey(project))),
    )
    .toSorted((a, b) => a.title.localeCompare(b.title));
  const projectByKey = new Map(projects.map((project) => [projectKey(project), project]));
  const scopedProject = props.search.project
    ? (projectByKey.get(props.search.project) ?? null)
    : null;
  const scopeKey = scopedProject ? projectKey(scopedProject) : ALL_PROJECTS_SCOPE;
  const scopePreferences: FeaturesScopePreferences =
    preferences.scopes[scopeKey] ?? DEFAULT_SCOPE_PREFERENCES;
  const targets = (scopedProject ? [scopedProject] : projects).map((project) => ({
    environmentId: project.environmentId,
    projectId: project.id,
  }));
  const board = useFeatureBoard(targets);
  const projectFor = (item: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => projectByKey.get(`${item.environmentId}:${item.projectId}`) ?? null;

  const updatePreferences = (patch: Partial<FeaturesPagePreferences>) => {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    saveFeaturesPagePreferences(next);
  };
  const updateScopePreferences = (patch: Partial<FeaturesScopePreferences>) =>
    updatePreferences({
      scopes: { ...preferences.scopes, [scopeKey]: { ...scopePreferences, ...patch } },
    });
  const featureLayout = preferences.featureLayout ?? "board";
  const issueDisplay = preferences.issues ?? DEFAULT_ISSUE_DISPLAY;
  const updateIssueDisplay = (patch: Partial<IssueDisplayPreferences>) =>
    updatePreferences({ issues: { ...issueDisplay, ...patch } });

  // Search and filters narrow every view; Needs you ignores the state filter.
  const parsedSearch = parseFeatureSearch(query);
  const visibleCards = board.cards.filter(
    (card) =>
      matchesFeatureSearch(card, parsedSearch, [projectFor(card)?.title]) &&
      (needsYou || stateFilters.size === 0 || stateFilters.has(cardFilterState(card))),
  );
  const queuePositions = featureQueuePositions(board.cards);
  const phaseGroups = groupFeaturesByPhase(visibleCards);

  const waitingThreads = useAtomValue(needsYouThreadsAtom);
  const scopedWaitingThreads = waitingThreads.filter(
    (shell) =>
      (scopedProject === null
        ? railProjectKeys === null ||
          railProjectKeys.has(`${shell.environmentId}:${shell.projectId}`)
        : shell.environmentId === scopedProject.environmentId &&
          shell.projectId === scopedProject.id) &&
      (!parsedSearch.text || shell.title.toLowerCase().includes(parsedSearch.text)) &&
      parsedSearch.workflows.length === 0,
  );
  const needsYouGroups = collectNeedsYou({ cards: visibleCards, shells: scopedWaitingThreads });
  const needsYouCount = needsYouGroups.reduce((total, group) => total + group.items.length, 0);

  // The Workflow toggle draws one workflow's stages; definitions load only while it is on.
  const workflowToggle = isFeatures && scopePreferences.workflow && !needsYou;
  const selectedWorkflowId = scopePreferences.workflowId ?? mostUsedWorkflowId(board.cards);
  // Workflows are an environment-wide library; read them where the chosen workflow runs.
  const definitionCard = board.cards.find((card) => card.workflow.id === selectedWorkflowId);
  const definitionSource =
    scopedProject ?? (definitionCard ? projectFor(definitionCard) : null) ?? projects[0] ?? null;
  const definitions = useEnvironmentQuery(
    workflowToggle && definitionSource
      ? workflowsEnvironment.definitions({
          environmentId: definitionSource.environmentId,
          input: {},
        })
      : null,
  );
  const workflowNames = new Map<string, string>();
  for (const definition of definitions.data ?? [])
    workflowNames.set(definition.id, definition.name);
  for (const card of board.cards) workflowNames.set(card.workflow.id, card.workflow.name);
  const workflowOptions = [...workflowNames].map(([id, name]) => ({ id, name }));
  const selectedDefinition =
    definitions.data?.find((definition) => definition.id === selectedWorkflowId) ?? null;
  // Definitions are per project, so the stage board draws only the source project's cards;
  // the same workflow id elsewhere may be a different graph, and is counted as hidden.
  const stageBoard = buildStageBoard();
  function buildStageBoard() {
    if (!selectedDefinition || !definitionSource) return null;
    const inSource = (card: EnvironmentFeatureCard) =>
      card.environmentId === definitionSource.environmentId &&
      card.projectId === definitionSource.id;
    const stages = buildFeatureStageBoard(selectedDefinition, visibleCards.filter(inSource));
    const elsewhere = new Map<string, number>();
    for (const card of visibleCards) {
      if (inSource(card)) continue;
      const title = projectFor(card)?.title ?? "Other projects";
      elsewhere.set(title, (elsewhere.get(title) ?? 0) + 1);
    }
    return elsewhere.size === 0
      ? stages
      : {
          ...stages,
          hidden: [...stages.hidden, ...[...elsewhere].map(([name, count]) => ({ name, count }))],
        };
  }

  const actions = useFeatureActions({ onNoteRequest: setNoteRequest });
  const newThread = useNewThreadHandler();
  const handlers: FeatureBoardHandlers = {
    projectFor,
    queuePositions,
    onOpen: (card) => {
      actions.openCard(card);
    },
    onMenu: (card: EnvironmentFeatureCard, event: MouseEvent) =>
      void actions.showMenu(card, { x: event.clientX, y: event.clientY }),
    onDrop: (card, action, position) =>
      void (action === "cancel"
        ? actions.run(card, "cancel")
        : actions.reopenFromDrop(card, position)),
  };
  // Issues load on the Issues and Milestones views, and on an empty Features board to
  // suggest a first feature.
  const featuresEmpty = board.loaded && board.errors.length === 0 && board.cards.length === 0;
  const issueBoard = useIssueBoard(targets, !isFeatures || featuresEmpty);
  const issueFeatures = featuresByIssue(board.cards);
  const featureFor = (issue: EnvironmentIssue) => featureForIssue(issueFeatures, issue);
  const laneFor = (issue: EnvironmentIssue) => issueLane(issue, featureFor(issue));
  const milestoneFilter = props.search.milestone ?? null;
  const filteredMilestone = milestoneFilter
    ? (issueBoard.milestones.find((milestone) => issueKey(milestone) === milestoneFilter) ?? null)
    : null;
  const issueBoardLayout = issueDisplay.layout === "board";
  const visibleIssues = issueBoard.issues.filter(
    (issue) =>
      (sourceFilters.size === 0 || sourceFilters.has(issue.ticketId ? "ticket" : "github")) &&
      // The board always has a Done lane, so it always shows what was closed lately.
      (issue.state === "open" || issueDisplay.showClosed || issueBoardLayout) &&
      (milestoneFilter === null ||
        (issue.milestone !== null &&
          issueKey({ ...issue, number: issue.milestone.number }) === milestoneFilter)) &&
      (laneFilters.size === 0 || laneFilters.has(laneFor(issue))) &&
      (labelFilters.size === 0 || issue.labels.some((label) => labelFilters.has(label.name))) &&
      matchesIssueSearch(issue, parsedSearch.text),
  );
  const issueGroups = groupIssues({
    issues: visibleIssues,
    milestones: issueBoard.milestones,
    groupBy: issueBoardLayout ? "status" : issueDisplay.groupBy,
    nested: issueDisplay.nested && !issueBoardLayout,
    laneFor,
    projectTitle: (owner) => projectFor(owner)?.title ?? null,
  });
  const issueLabels = [
    ...new Set(issueBoard.issues.flatMap((issue) => issue.labels.map((label) => label.name))),
  ]
    .toSorted((a, b) => a.localeCompare(b))
    .slice(0, 30);

  const openLink = useOpenLink(null);
  const startFeatureFromTodo = useStartFeatureFromTodo();
  const issueHandlers: IssueViewHandlers = {
    projectFor,
    featureFor,
    laneFor,
    onOpenIssue: (issue) =>
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
    onOpenExternal: (issue) =>
      void openLink(issue.url).catch((error: unknown) => console.error(error)),
    onOpenFeature: (card) => actions.openCard(card),
    onStartFeature: (issue) =>
      void startFeatureFromTodo(issue, issueBoard.tickets.get(issueKey(issue))?.description),
    showProject: scopedProject === null && projects.length > 1,
    display: issueDisplay,
  };
  const suggestedIssues = issueBoard.issues
    .filter((issue) => issue.state === "open" && featureFor(issue) === null)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);
  const setView = (next: BoardView) =>
    props.onSearchChange({
      view: next === "features" ? undefined : next,
      milestone: undefined,
      needsYou: undefined,
    });

  const openNeedsYouItem = (item: NeedsYouItem) => {
    if (item.type === "feature") {
      actions.openCard(item.card);
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: item.shell.environmentId, threadId: item.shell.id },
    });
  };

  // New feature: a new thread in the scoped project. The composer's Workflow picker turns
  // its first message into the brief.
  const ensureStarter = useAtomCommand(workflowsEnvironment.ensureStarter);
  const newFeatureProject: EnvironmentProject | null = scopedProject ?? projects[0] ?? null;
  const startNewFeature = async (withStarter: boolean) => {
    if (!newFeatureProject) return;
    if (withStarter) {
      const result = await ensureStarter({
        environmentId: newFeatureProject.environmentId,
        input: {},
      });
      if (result._tag !== "Success") return;
    }
    await newThread(scopeProjectRef(newFeatureProject.environmentId, newFeatureProject.id));
  };
  const browseWorkflows = () => void navigate({ to: "/library", search: {} });

  const shortcutTitle = (label: string, command: Parameters<typeof shortcutLabelForCommand>[1]) => {
    const shortcut = shortcutLabelForCommand(keybindings, command, {
      context: { featuresPageOpen: true },
    });
    return shortcut ? `${label} (${shortcut})` : label;
  };
  const toggleNeedsYou = () => props.onSearchChange({ needsYou: needsYou ? undefined : true });
  // From Needs you, Workflow opens the stage board; on it, it closes it.
  const toggleWorkflow = () => {
    updateScopePreferences({ workflow: !workflowToggle });
    if (needsYou) props.onSearchChange({ needsYou: undefined });
  };

  const newTodo = () =>
    openNewTodoDialog(
      newFeatureProject
        ? {
            project: {
              environmentId: newFeatureProject.environmentId,
              projectId: newFeatureProject.id,
            },
          }
        : {},
    );

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
    event.preventDefault();
    event.stopPropagation();
    if (command === "features.search") {
      setSearchOpen(true);
      searchInputRef.current?.focus();
    } else if (command === "features.workflow") toggleWorkflow();
    else if (command === "features.newTodo") newTodo();
    else toggleNeedsYou();
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- Subscribes the page's shortcuts to window keydown while it is mounted.
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
  // oxlint-disable-next-line t3code/react-effect-budget -- Debounces the field into the URL; the timer is cleared on the next keystroke or unmount.
  useEffect(() => {
    if (urlQuery === query) return;
    const handle = window.setTimeout(() => {
      setWrittenQuery(query);
      onSearchChange({ q: query || undefined });
    }, 300);
    return () => window.clearTimeout(handle);
  }, [onSearchChange, query, urlQuery]);

  const filtersActive = stateFilters.size > 0;
  const firstRun =
    board.loaded &&
    board.errors.length === 0 &&
    board.cards.length === 0 &&
    scopedWaitingThreads.length === 0 &&
    !query &&
    !filtersActive;

  const clearFilters = () => {
    setStateFilters(new Set());
    setLaneFilters(new Set());
    setLabelFilters(new Set());
    setSourceFilters(new Set());
    if (scopedProject) props.onSearchChange({ project: undefined });
  };
  const stateOptions = ["not-started", ...STATE_FILTERS] as const;
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
              props.onSearchChange({ project: checked ? value : undefined }),
          },
        ]
      : []),
    ...(isFeatures
      ? [
          {
            label: "State",
            options: stateOptions.map((state) => ({
              value: state,
              label:
                state === "not-started"
                  ? "Not started"
                  : featureStatus({ state, started: true } as EnvironmentFeatureCard, undefined)
                      .label,
              checked: stateFilters.has(state),
            })),
            onChange: (value: string, checked: boolean) => {
              const state = stateOptions.find((candidate) => candidate === value);
              if (state) setStateFilters((current) => toggled(current, state, checked));
            },
          },
        ]
      : []),
    ...(view === "issues"
      ? [
          {
            label: "Status",
            options: ISSUE_LANES.map((lane) => ({
              value: lane,
              label: ISSUE_LANE_LABELS[lane],
              checked: laneFilters.has(lane),
            })),
            onChange: (value: string, checked: boolean) => {
              const lane = ISSUE_LANES.find((candidate) => candidate === value);
              if (lane) setLaneFilters((current) => toggled(current, lane, checked));
            },
          },
          {
            label: "Source",
            options: Object.entries(TODO_SOURCES).map(([value, label]) => ({
              value,
              label,
              checked: sourceFilters.has(value as TodoSource),
            })),
            onChange: (value: string, checked: boolean) => {
              if (value === "ticket" || value === "github")
                setSourceFilters((current) => toggled(current, value, checked));
            },
          },
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
  const leaveNeedsYou = () => {
    if (needsYou) props.onSearchChange({ needsYou: undefined });
  };

  const headerActions = (
    <div className="ms-auto flex min-w-0 items-center gap-1">
      {isFeatures && (needsYouCount > 0 || needsYou) ? (
        <Button
          size="sm"
          variant={needsYou ? "default" : "warning-outline"}
          aria-pressed={needsYou}
          title={shortcutTitle("Needs you", "features.needsYou")}
          onClick={toggleNeedsYou}
        >
          {needsYouCount} need{needsYouCount === 1 ? "s" : ""} you
        </Button>
      ) : null}
      {searchOpen || query ? (
        <InputGroup className="w-44 md:w-60">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchInputRef}
            type="search"
            autoFocus
            aria-label={isFeatures ? "Search features" : "Search issues"}
            placeholder={isFeatures ? "Search, or workflow:bug-fix" : "Search, #number, label"}
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
          aria-label={isFeatures ? "Search features" : "Search issues"}
          title="Search (/)"
          onClick={() => setSearchOpen(true)}
        >
          <SearchIcon aria-hidden />
        </Button>
      )}
      <BoardFilterMenu sections={filterSections} onClear={clearFilters} />
      {isFeatures ? (
        <FeatureDisplayMenu
          layout={featureLayout}
          onLayout={(layout) => {
            updatePreferences({ featureLayout: layout });
            leaveNeedsYou();
          }}
          stages={workflowToggle}
          stagesLabel={shortcutTitle("Workflow stages", "features.workflow")}
          onStages={(stages) => {
            updateScopePreferences({ workflow: stages });
            leaveNeedsYou();
          }}
          workflows={workflowOptions}
          workflowId={selectedWorkflowId ?? null}
          onWorkflow={(workflowId) => updateScopePreferences({ workflowId })}
        />
      ) : view === "issues" ? (
        <IssueDisplayMenu display={issueDisplay} onChange={updateIssueDisplay} />
      ) : null}
      {isFeatures ? null : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh issues"
          title={
            issueBoard.readAt
              ? `Read from GitHub ${formatRelativeTimeLabel(issueBoard.readAt)}`
              : "Refresh"
          }
          disabled={issueBoard.refreshing}
          onClick={issueBoard.refresh}
        >
          <RefreshCwIcon aria-hidden />
        </Button>
      )}
      {isFeatures && !firstRun ? (
        <Button size="sm" onClick={() => void startNewFeature(false)} disabled={!newFeatureProject}>
          <PlusIcon aria-hidden />
          <span className="hidden md:inline">New feature</span>
        </Button>
      ) : null}
      {isFeatures ? null : (
        <Button
          size="sm"
          title={shortcutTitle("New todo", "features.newTodo")}
          onClick={newTodo}
          disabled={!newFeatureProject}
        >
          <PlusIcon aria-hidden />
          <span className="hidden md:inline">New todo</span>
        </Button>
      )}
    </div>
  );

  let body;
  if (projects.length === 0) {
    body = (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Connect an environment that runs workflows to see features.
      </p>
    );
  } else if (!isFeatures) {
    // Without GitHub anywhere, the view still lists tickets, and only Milestones has nothing.
    const allUnavailable =
      issueBoard.unavailable.length > 0 &&
      issueBoard.unavailable.length === targets.length &&
      (view === "milestones" || issueBoard.issues.length === 0);
    if (issueBoard.pending && issueBoard.issues.length === 0) {
      body = (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      );
    } else if (allUnavailable) {
      body = (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {issueBoard.unavailable[0]!.reason}
          {view === "issues" ? " Tickets work without one: add one with New todo." : null}
        </p>
      );
    } else if (view === "milestones") {
      body = (
        <MilestonesView
          milestones={issueBoard.milestones}
          issues={issueBoard.issues}
          handlers={issueHandlers}
          onOpenMilestone={(milestone) =>
            props.onSearchChange({ view: "issues", milestone: issueKey(milestone) })
          }
        />
      );
    } else if (visibleIssues.length === 0 && issueBoard.errors.length === 0) {
      body = (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {issueBoard.issues.length === 0 ? "No open todos." : "No todos match."}
        </p>
      );
    } else if (issueBoardLayout) {
      body = <IssueBoardView groups={issueGroups} handlers={issueHandlers} />;
    } else {
      body = <IssueListView groups={issueGroups} handlers={issueHandlers} />;
    }
  } else if (firstRun) {
    body = (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-5 py-14 text-center">
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-lg font-medium">No features yet</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Write a brief and your crew takes it through a workflow, stage by stage. Stages that
            need your approval wait under Needs you.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void startNewFeature(true)} disabled={!newFeatureProject}>
            Start a feature
          </Button>
          <Button variant="outline" onClick={browseWorkflows}>
            Browse workflows
          </Button>
        </div>
        <IssueSuggestions
          issues={suggestedIssues}
          handlers={issueHandlers}
          onShowAll={() => setView("issues")}
        />
      </div>
    );
  } else if (board.pending && board.cards.length === 0) {
    body = (
      <div className="flex gap-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-40 w-64" />
        ))}
      </div>
    );
  } else if (needsYou) {
    body = (
      <NeedsYouListView
        groups={needsYouGroups}
        projectFor={projectFor}
        actions={actions}
        onOpenThread={openNeedsYouItem}
      />
    );
  } else if (workflowToggle) {
    body = stageBoard ? (
      <FeatureStageBoardView
        board={stageBoard}
        handlers={handlers}
        gateFilter={gateFilter}
        onGateFilter={setGateFilter}
        onOpenStage={browseWorkflows}
        onShowPhases={() => updateScopePreferences({ workflow: false })}
      />
    ) : (
      <p className="py-10 text-center text-sm text-muted-foreground">
        {definitions.isPending ? "Loading the workflow…" : "Pick a workflow to see its stages."}
      </p>
    );
  } else if (featureLayout === "list") {
    body = <FeaturePhaseList groups={phaseGroups} handlers={handlers} />;
  } else {
    body = <FeaturePhaseBoard groups={phaseGroups} handlers={handlers} />;
  }

  const partlyUnavailable =
    !isFeatures &&
    issueBoard.unavailable.length > 0 &&
    issueBoard.unavailable.length < targets.length;
  const notes = isFeatures ? null : (
    <>
      {filteredMilestone || milestoneFilter ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Milestone</span>
          <span className="inline-flex h-6 items-center gap-1 rounded-md border border-border/70 ps-2 pe-0.5">
            <MilestoneIcon aria-hidden className="size-3.5 text-muted-foreground" />
            {filteredMilestone?.title ?? "Closed milestone"}
            <button
              type="button"
              aria-label="Show every milestone"
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => props.onSearchChange({ milestone: undefined })}
            >
              <XIcon aria-hidden className="size-3" />
            </button>
          </span>
        </div>
      ) : null}
      {issueBoard.errors.length > 0 ? (
        <p role="alert" className="text-sm text-destructive">
          {issueBoard.errors[0]}
        </p>
      ) : null}
      {partlyUnavailable ? (
        <p className="text-xs text-muted-foreground">
          {issueBoard.unavailable.length === 1
            ? `${projectFor(issueBoard.unavailable[0]!)?.title ?? "One project"}: ${issueBoard.unavailable[0]!.reason}`
            : `${issueBoard.unavailable.length} projects have no GitHub issues to show.`}
        </p>
      ) : null}
      {issueBoard.truncated ? (
        <p className="text-xs text-muted-foreground">
          Showing the 100 most recently updated open issues per project. Search narrows them.
        </p>
      ) : null}
    </>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="sr-only">Board</h1>
          <ToggleGroup
            aria-label="Board view"
            variant="segmented"
            value={[view]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "features" || next === "issues" || next === "milestones") setView(next);
            }}
          >
            <Toggle value="features">
              <LayersIcon aria-hidden />
              Features
            </Toggle>
            <Toggle value="issues">
              <CircleDotIcon aria-hidden />
              Issues
            </Toggle>
            <Toggle value="milestones">
              <MilestoneIcon aria-hidden />
              Milestones
            </Toggle>
          </ToggleGroup>
          {firstRun && isFeatures ? null : headerActions}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="full" className="gap-3">
            <BoardFilterChips sections={filterSections} onClear={clearFilters} />
            {board.errors.length > 0 ? (
              <p role="alert" className="text-sm text-destructive">
                {board.errors[0]}
              </p>
            ) : null}
            {notes}
            {body}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      <FeatureNoteDialog
        request={noteRequest}
        onClose={() => setNoteRequest(null)}
        onSubmit={(request, text) =>
          actions.run(request.card, request.action, {
            text,
            ...(request.outcome === undefined ? {} : { outcome: request.outcome }),
          })
        }
      />
    </SidebarInset>
  );
}
