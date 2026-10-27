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
  milestoneKey,
  type EnvironmentIssue,
  type IssueLane,
} from "@t3tools/client-runtime/state/issue-board";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleDotIcon,
  LayersIcon,
  ListFilterIcon,
  MilestoneIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useState, type MouseEvent } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { useComposerDraftStore } from "../../composerDraftStore";
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
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { FeatureDisplayMenu, IssueDisplayMenu } from "./BoardDisplayMenu";
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

export interface FeaturesSearch {
  readonly needsYou?: boolean;
  readonly q?: string;
  /** `environmentId:projectId`; absent is All projects. */
  readonly project?: string;
  /** Absent is Features. */
  readonly view?: "issues" | "milestones";
  /** The `milestoneKey` the Issues view is narrowed to. */
  readonly milestone?: string;
}

type BoardView = "features" | "issues" | "milestones";

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

const FIRST_RUN_STEPS = [
  { title: "Write a brief", detail: "Describe the work, or start from a GitHub issue." },
  { title: "The crew runs it", detail: "Each workflow stage goes to the role that owns it." },
  { title: "You approve the gates", detail: "Stages that need you wait under Needs you." },
] as const;

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
  const [stateFilters, setStateFilters] = useState<ReadonlySet<StateFilter>>(new Set());
  const [gateFilter, setGateFilter] = useState<string | null>(null);
  const [noteRequest, setNoteRequest] = useState<FeatureNoteRequest | null>(null);
  const view: BoardView = props.search.view ?? "features";
  const isFeatures = view === "features";
  const needsYou = isFeatures && props.search.needsYou === true;
  const [laneFilters, setLaneFilters] = useState<ReadonlySet<IssueLane>>(new Set());
  const [labelFilters, setLabelFilters] = useState<ReadonlySet<string>>(new Set());

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
    ? (issueBoard.milestones.find((milestone) => milestoneKey(milestone) === milestoneFilter) ??
      null)
    : null;
  const issueBoardLayout = issueDisplay.layout === "board";
  const visibleIssues = issueBoard.issues.filter(
    (issue) =>
      // The board always has a Done lane, so it always shows what was closed lately.
      (issue.state === "open" || issueDisplay.showClosed || issueBoardLayout) &&
      (milestoneFilter === null ||
        (issue.milestone !== null &&
          milestoneKey({ ...issue, number: issue.milestone.number }) === milestoneFilter)) &&
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
  // Start feature: a new thread in the issue's project whose brief links the issue. The
  // composer's Workflow picker starts it, and creating the feature links the issue.
  const startFeatureFromIssue = async (issue: EnvironmentIssue) => {
    const created = await newThread(scopeProjectRef(issue.environmentId, issue.projectId));
    if (!created) return;
    const drafts = useComposerDraftStore.getState();
    const brief = `${issue.title}\n\n${issue.url}`;
    // A reused draft keeps what was already written.
    const existing = drafts.getComposerDraft(created.draftId)?.prompt.trim() ?? "";
    drafts.setPrompt(created.draftId, existing ? `${existing}\n\n${brief}` : brief);
  };
  const issueHandlers: IssueViewHandlers = {
    projectFor,
    featureFor,
    laneFor,
    onOpenIssue: (issue) =>
      void openLink(issue.url).catch((error: unknown) => console.error(error)),
    onOpenFeature: (card) => actions.openCard(card),
    onStartFeature: (issue) => void startFeatureFromIssue(issue),
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
  const browseWorkflows = () => void navigate({ to: "/settings/projects" });

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
    if (command === "features.workflow") toggleWorkflow();
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
  const issueFiltersActive = laneFilters.size > 0 || labelFilters.size > 0;
  const firstRun =
    board.loaded &&
    board.errors.length === 0 &&
    board.cards.length === 0 &&
    scopedWaitingThreads.length === 0 &&
    !query &&
    !filtersActive;

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <InputGroup className="min-w-48 flex-1">
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label={isFeatures ? "Search features" : "Search issues"}
          placeholder={isFeatures ? "Search, or workflow:bug-fix" : "Search, #number, label"}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </InputGroup>
      {isFeatures ? (
        <>
          <Button
            variant={needsYou ? "default" : "outline"}
            aria-pressed={needsYou}
            title={shortcutTitle("Needs you", "features.needsYou")}
            onClick={toggleNeedsYou}
          >
            Needs you
            <span className="tabular-nums opacity-80">{needsYouCount}</span>
          </Button>
          <Button
            variant={workflowToggle ? "default" : "outline"}
            aria-pressed={workflowToggle}
            title={shortcutTitle("Workflow", "features.workflow")}
            onClick={toggleWorkflow}
          >
            <WorkflowIcon aria-hidden />
            Workflow
          </Button>
          {workflowToggle && workflowOptions.length > 0 ? (
            <Select
              value={selectedWorkflowId ?? ""}
              onValueChange={(value) => updateScopePreferences({ workflowId: value || null })}
            >
              <SelectTrigger aria-label="Workflow" className="w-auto min-w-36">
                <SelectValue>
                  {(selectedDefinition?.name ??
                    workflowOptions.find((option) => option.id === selectedWorkflowId)?.name ??
                    "Workflow") + (selectedDefinition ? ` · v${selectedDefinition.revision}` : "")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {workflowOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </>
      ) : null}
      <Select
        value={scopeKey}
        onValueChange={(value) =>
          props.onSearchChange({
            project: !value || value === ALL_PROJECTS_SCOPE ? undefined : value,
          })
        }
      >
        <SelectTrigger aria-label="Project scope" className="w-auto min-w-36">
          <SelectValue>{scopedProject?.title ?? "All projects"}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={ALL_PROJECTS_SCOPE}>All projects</SelectItem>
          {projects.map((project) => (
            <SelectItem key={projectKey(project)} value={projectKey(project)}>
              {project.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {isFeatures ? (
        <Menu>
          <MenuTrigger
            render={
              <Button variant={filtersActive ? "default" : "outline"} aria-label="Filters">
                <ListFilterIcon aria-hidden />
                Filters
              </Button>
            }
          />
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>State</MenuGroupLabel>
              {(["not-started", ...STATE_FILTERS] as const).map((state) => (
                <MenuCheckboxItem
                  key={state}
                  checked={stateFilters.has(state)}
                  onCheckedChange={(checked) =>
                    setStateFilters((current) => {
                      const next = new Set(current);
                      if (checked) next.add(state);
                      else next.delete(state);
                      return next;
                    })
                  }
                >
                  {state === "not-started"
                    ? "Not started"
                    : featureStatus({ state, started: true } as EnvironmentFeatureCard, undefined)
                        .label}
                </MenuCheckboxItem>
              ))}
            </MenuGroup>
            {filtersActive ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => setStateFilters(new Set())}>Clear filters</MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      ) : view === "issues" ? (
        <Menu>
          <MenuTrigger
            render={
              <Button variant={issueFiltersActive ? "default" : "outline"} aria-label="Filters">
                <ListFilterIcon aria-hidden />
                Filters
              </Button>
            }
          />
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>Status</MenuGroupLabel>
              {ISSUE_LANES.map((lane) => (
                <MenuCheckboxItem
                  key={lane}
                  checked={laneFilters.has(lane)}
                  onCheckedChange={(checked) =>
                    setLaneFilters((current) => toggled(current, lane, checked))
                  }
                >
                  {ISSUE_LANE_LABELS[lane]}
                </MenuCheckboxItem>
              ))}
            </MenuGroup>
            {issueLabels.length > 0 ? (
              <>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>Label</MenuGroupLabel>
                  {issueLabels.map((label) => (
                    <MenuCheckboxItem
                      key={label}
                      checked={labelFilters.has(label)}
                      onCheckedChange={(checked) =>
                        setLabelFilters((current) => toggled(current, label, checked))
                      }
                    >
                      {label}
                    </MenuCheckboxItem>
                  ))}
                </MenuGroup>
              </>
            ) : null}
            {issueFiltersActive ? (
              <>
                <MenuSeparator />
                <MenuItem
                  onClick={() => {
                    setLaneFilters(new Set());
                    setLabelFilters(new Set());
                  }}
                >
                  Clear filters
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      ) : null}
      {isFeatures ? (
        workflowToggle || needsYou ? null : (
          <FeatureDisplayMenu
            layout={featureLayout}
            onLayout={(layout) => updatePreferences({ featureLayout: layout })}
          />
        )
      ) : view === "issues" ? (
        <IssueDisplayMenu display={issueDisplay} onChange={updateIssueDisplay} />
      ) : null}
      {isFeatures ? null : (
        <Button
          variant="outline"
          size="icon"
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
      <Button onClick={() => void startNewFeature(false)} disabled={!newFeatureProject}>
        <PlusIcon aria-hidden />
        New feature
      </Button>
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
    const allUnavailable =
      issueBoard.unavailable.length > 0 && issueBoard.unavailable.length === targets.length;
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
        </p>
      );
    } else if (view === "milestones") {
      body = (
        <MilestonesView
          milestones={issueBoard.milestones}
          issues={issueBoard.issues}
          handlers={issueHandlers}
          onOpenMilestone={(milestone) =>
            props.onSearchChange({ view: "issues", milestone: milestoneKey(milestone) })
          }
        />
      );
    } else if (visibleIssues.length === 0 && issueBoard.errors.length === 0) {
      body = (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {issueBoard.issues.length === 0 ? "No open issues." : "No issues match."}
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
            A feature is a brief that your crew takes through a workflow. You approve the gates.
          </p>
        </div>
        <ol className="grid w-full gap-2 text-left sm:grid-cols-3">
          {FIRST_RUN_STEPS.map((step, index) => (
            <li
              key={step.title}
              className="flex flex-col gap-1 rounded-xl border border-border/70 bg-card p-3"
            >
              <span className="text-xs text-muted-foreground tabular-nums">{index + 1}</span>
              <span className="text-sm font-medium">{step.title}</span>
              <span className="text-xs text-muted-foreground">{step.detail}</span>
            </li>
          ))}
        </ol>
        <div className="flex gap-2">
          <Button onClick={() => void startNewFeature(true)} disabled={!newFeatureProject}>
            Start a feature
          </Button>
          <Button variant="outline" onClick={browseWorkflows}>
            Browse workflows
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Uses “Feature delivery” and the default crew. Both can be changed in Settings.
        </p>
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
          <WorkspaceBreadcrumb ariaLabel="Board breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Board</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
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
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="full" className="gap-3">
            {controls}
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
