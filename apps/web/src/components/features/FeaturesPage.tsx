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
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ListFilterIcon, PlusIcon, SearchIcon, WorkflowIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { shortcutLabelForCommand } from "../../keybindings";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { useProjects } from "../../state/entities";
import { needsYouThreadsAtom } from "../../state/needsYou";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { featureStatus } from "./FeatureCard";
import {
  FeaturePhaseBoard,
  FeatureStageBoardView,
  type FeatureBoardHandlers,
} from "./FeatureBoards";
import { NeedsYouListView } from "./FeatureLists";
import { FeatureNoteDialog } from "./FeatureNoteDialog";
import {
  ALL_PROJECTS_SCOPE,
  DEFAULT_SCOPE_PREFERENCES,
  readFeaturesPagePreferences,
  saveFeaturesPagePreferences,
  type FeaturesPagePreferences,
  type FeaturesScopePreferences,
} from "./featuresPagePreferences";
import { resolveFeaturesShortcut } from "./featuresShortcuts";
import { useFeatureActions, type FeatureNoteRequest } from "./useFeatureActions";
import { useFeatureBoard, useWorkflowEnvironmentIds } from "./useFeatureBoard";

export interface FeaturesSearch {
  readonly needsYou?: boolean;
  readonly q?: string;
  /** `environmentId:projectId`; absent is All projects. */
  readonly project?: string;
}

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
  const needsYou = props.search.needsYou === true;

  // Projects on servers that run workflows; the scope picker lists only these.
  const workflowEnvironmentIds = useWorkflowEnvironmentIds();
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects
        .filter((project) => workflowEnvironmentIds.has(project.environmentId))
        .toSorted((a, b) => a.title.localeCompare(b.title)),
    [allProjects, workflowEnvironmentIds],
  );
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [projectKey(project), project])),
    [projects],
  );
  const scopedProject = props.search.project
    ? (projectByKey.get(props.search.project) ?? null)
    : null;
  const scopeKey = scopedProject ? projectKey(scopedProject) : ALL_PROJECTS_SCOPE;
  const scopePreferences: FeaturesScopePreferences =
    preferences.scopes[scopeKey] ?? DEFAULT_SCOPE_PREFERENCES;
  const targets = useMemo(
    () =>
      (scopedProject ? [scopedProject] : projects).map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
      })),
    [projects, scopedProject],
  );
  const board = useFeatureBoard(targets);
  const projectFor = useCallback(
    (item: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId }) =>
      projectByKey.get(`${item.environmentId}:${item.projectId}`) ?? null,
    [projectByKey],
  );

  const updatePreferences = (patch: Partial<FeaturesPagePreferences>) => {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    saveFeaturesPagePreferences(next);
  };
  const updateScopePreferences = (patch: Partial<FeaturesScopePreferences>) =>
    updatePreferences({
      scopes: { ...preferences.scopes, [scopeKey]: { ...scopePreferences, ...patch } },
    });

  // Search and filters narrow every view; Needs you ignores the state filter.
  const parsedSearch = useMemo(() => parseFeatureSearch(query), [query]);
  const visibleCards = useMemo(
    () =>
      board.cards.filter(
        (card) =>
          matchesFeatureSearch(card, parsedSearch, [projectFor(card)?.title]) &&
          (needsYou || stateFilters.size === 0 || stateFilters.has(cardFilterState(card))),
      ),
    [board.cards, needsYou, parsedSearch, projectFor, stateFilters],
  );
  const queuePositions = useMemo(() => featureQueuePositions(board.cards), [board.cards]);
  const phaseGroups = useMemo(() => groupFeaturesByPhase(visibleCards), [visibleCards]);

  const waitingThreads = useAtomValue(needsYouThreadsAtom);
  const scopedWaitingThreads = useMemo(
    () =>
      waitingThreads.filter(
        (shell) =>
          (scopedProject === null
            ? true
            : shell.environmentId === scopedProject.environmentId &&
              shell.projectId === scopedProject.id) &&
          (!parsedSearch.text || shell.title.toLowerCase().includes(parsedSearch.text)) &&
          parsedSearch.workflows.length === 0,
      ),
    [parsedSearch, scopedProject, waitingThreads],
  );
  const needsYouGroups = useMemo(
    () => collectNeedsYou({ cards: visibleCards, shells: scopedWaitingThreads }),
    [scopedWaitingThreads, visibleCards],
  );
  const needsYouCount = needsYouGroups.reduce((total, group) => total + group.items.length, 0);

  // The Workflow toggle draws one workflow's stages; definitions load only while it is on.
  const workflowToggle = scopePreferences.workflow && !needsYou;
  const selectedWorkflowId = scopePreferences.workflowId ?? mostUsedWorkflowId(board.cards);
  // Definitions come from a project that runs the chosen workflow; one per environment suffices.
  const definitionCard = board.cards.find((card) => card.workflow.id === selectedWorkflowId);
  const definitionSource =
    scopedProject ?? (definitionCard ? projectFor(definitionCard) : null) ?? projects[0] ?? null;
  const definitions = useEnvironmentQuery(
    workflowToggle && definitionSource
      ? workflowsEnvironment.definitions({
          environmentId: definitionSource.environmentId,
          input: { projectId: definitionSource.id },
        })
      : null,
  );
  const workflowOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const definition of definitions.data ?? []) options.set(definition.id, definition.name);
    for (const card of board.cards) options.set(card.workflow.id, card.workflow.name);
    return [...options].map(([id, name]) => ({ id, name }));
  }, [board.cards, definitions.data]);
  const selectedDefinition =
    definitions.data?.find((definition) => definition.id === selectedWorkflowId) ?? null;
  // Definitions are per project, so the stage board draws only the source project's cards;
  // the same workflow id elsewhere may be a different graph, and is counted as hidden.
  const stageBoard = useMemo(() => {
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
  }, [definitionSource, projectFor, selectedDefinition, visibleCards]);

  const actions = useFeatureActions({ onNoteRequest: setNoteRequest });
  const handlers = useMemo<FeatureBoardHandlers>(
    () => ({
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
    }),
    [actions, projectFor, queuePositions],
  );
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
  const newThread = useNewThreadHandler();
  const ensureStarter = useAtomCommand(workflowsEnvironment.ensureStarter);
  const newFeatureProject: EnvironmentProject | null = scopedProject ?? projects[0] ?? null;
  const startNewFeature = async (withStarter: boolean) => {
    if (!newFeatureProject) return;
    if (withStarter) {
      const result = await ensureStarter({
        environmentId: newFeatureProject.environmentId,
        input: { projectId: newFeatureProject.id },
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
  useEffect(() => {
    window.addEventListener("keydown", onPageKeyDown, true);
    return () => window.removeEventListener("keydown", onPageKeyDown, true);
  }, []);

  // Keep the URL's query in step with the field, without a history entry per keystroke.
  // A URL change that isn't our own write (back, a link) replaces the field instead.
  const { onSearchChange } = props;
  const urlQuery = props.search.q ?? "";
  const writtenQuery = useRef(urlQuery);
  useEffect(() => {
    if (urlQuery === writtenQuery.current) return;
    writtenQuery.current = urlQuery;
    setQuery(urlQuery);
  }, [urlQuery]);
  useEffect(() => {
    if (urlQuery === query) return;
    const handle = window.setTimeout(() => {
      writtenQuery.current = query;
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

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <InputGroup className="min-w-48 flex-1">
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="Search features"
          placeholder="Search, or workflow:bug-fix"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </InputGroup>
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
  } else if (firstRun) {
    body = (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
        <h2 className="text-lg font-medium">No features yet</h2>
        <p className="text-sm text-muted-foreground">
          A feature is a brief that a crew of bots takes through a workflow: plan, design, build,
          verify, review. You approve the gates.
        </p>
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
  } else {
    body = <FeaturePhaseBoard groups={phaseGroups} handlers={handlers} />;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Board breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Board</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="gap-3">
            {controls}
            {board.errors.length > 0 ? (
              <p role="alert" className="text-sm text-destructive">
                {board.errors[0]}
              </p>
            ) : null}
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
