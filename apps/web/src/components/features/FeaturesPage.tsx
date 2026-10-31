import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  featureCardKey,
  featureQueuePositions,
  groupFeaturesByColumn,
  matchesFeatureSearch,
  parseFeatureSearch,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";
import {
  featureForIssue,
  featuresByIssue,
  issueKey,
  matchesIssueSearch,
  type EnvironmentIssue,
} from "@t3tools/client-runtime/state/issue-board";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  featureRows,
  workGroupOpenThread,
  workGroupThreads,
} from "@t3tools/client-runtime/state/work-groups";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type MouseEvent } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadActions } from "../../hooks/useThreadActions";
import { shortcutLabelForCommand } from "../../keybindings";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { useBotRailProjectKeys } from "../../state/botRail";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { workflowsEnvironment } from "../../state/workflows";
import { Button } from "../ui/button";
import { MainViewToggle } from "../MainViewToggle";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BoardDisplayMenu } from "./BoardDisplayMenu";
import { BoardFilterChips, BoardFilterMenu, type BoardFilterSection } from "./BoardFilters";
import { FeatureStatusBoard, type FeatureBoardHandlers } from "./FeatureBoards";
import { FeatureNoteDialog } from "./FeatureNoteDialog";
import {
  readFeaturesPagePreferences,
  saveFeaturesPagePreferences,
  type FeaturesPagePreferences,
} from "./featuresPagePreferences";
import { resolveFeaturesShortcut } from "./featuresShortcuts";
import { useFeatureActions, type FeatureNoteRequest } from "./useFeatureActions";
import { useFeatureBoard, useWorkflowEnvironmentIds } from "./useFeatureBoard";
import { useIssueBoard } from "./useIssueBoard";
import { useStartFeatureFromTodo } from "./TodoDetail";
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
 * The board: the main area's Board view, flipped from the sidebar's List / Board toggle. Todo,
 * Working, Needs you and Done, with settled features folded under Done as in the sidebar.
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
  const [noteRequest, setNoteRequest] = useState<FeatureNoteRequest | null>(null);
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

  const updatePreferences = (patch: Partial<FeaturesPagePreferences>) => {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    saveFeaturesPagePreferences(next);
  };
  const layout = preferences.featureLayout ?? "board";

  // A milestone narrows the board to its issues, and to the features that work on them.
  const issueFeatures = featuresByIssue(board.cards);
  const featureFor = (issue: EnvironmentIssue) => featureForIssue(issueFeatures, issue);
  const milestoneFilter = props.search.milestone ?? null;
  const inMilestone = (issue: EnvironmentIssue) =>
    milestoneFilter === null ||
    (issue.milestone !== null &&
      issueKey({ ...issue, number: issue.milestone.number }) === milestoneFilter);
  const milestoneFeatureKeys = new Set(
    issueBoard.issues.flatMap((issue) => {
      const feature = inMilestone(issue) ? featureFor(issue) : null;
      return feature ? [featureCardKey(feature)] : [];
    }),
  );

  const parsedSearch = parseFeatureSearch(query);
  const visibleCards = board.cards.filter(
    (card) =>
      matchesFeatureSearch(card, parsedSearch, [projectFor(card)?.title]) &&
      (milestoneFilter === null || milestoneFeatureKeys.has(featureCardKey(card))),
  );
  // Todo holds open issues no feature works on; a stopped feature hands its issue back.
  const todos = issueBoard.issues
    .filter((issue) => {
      const feature = featureFor(issue);
      return (
        issue.state === "open" &&
        (feature === null || feature.state === "cancelled") &&
        inMilestone(issue) &&
        (labelFilters.size === 0 || issue.labels.some((label) => labelFilters.has(label.name))) &&
        parsedSearch.workflows.length === 0 &&
        matchesIssueSearch(issue, parsedSearch.text)
      );
    })
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // A finished feature is settled when its row in the thread list is, so the board and the
  // sidebar file it the same way. One with no listed threads left (archived, or settled long
  // ago and no longer sent) counts as settled too.
  const { settleThread, unsettleThread } = useThreadActions();
  const rows = featureRows(useQuietThreadShells());
  const rowFor = (card: EnvironmentFeatureCard) => {
    const group = rows.get(featureCardKey(card));
    return group ? workGroupThreads(group) : [];
  };
  const isSettled = (card: EnvironmentFeatureCard) => {
    const primary = rowFor(card)[0];
    return primary === undefined || primary.settledOverride === "settled";
  };
  const closed = (card: EnvironmentFeatureCard) =>
    card.state === "done" || card.state === "cancelled";
  const settledCards = visibleCards
    .filter((card) => closed(card) && isSettled(card))
    .toSorted((a, b) => b.stateSince.localeCompare(a.stateSince));
  const groups = groupFeaturesByColumn(
    visibleCards.filter((card) => !closed(card) || !isSettled(card)),
  );
  const toggleShelf = (card: EnvironmentFeatureCard) => {
    const settled = isSettled(card);
    for (const thread of rowFor(card)) {
      if ((thread.settledOverride === "settled") !== settled) continue;
      const ref = scopeThreadRef(thread.environmentId, thread.id);
      void (settled ? unsettleThread(ref) : settleThread(ref)).then((result) => {
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: settled ? "Failed to un-settle feature" : "Failed to settle feature",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
    }
  };

  const actions = useFeatureActions({ onNoteRequest: setNoteRequest });
  const startFeatureFromTodo = useStartFeatureFromTodo();
  const handlers: FeatureBoardHandlers = {
    projectFor,
    queuePositions: featureQueuePositions(board.cards),
    // A card opens what its sidebar row opens: the thread waiting on you, else the lead.
    onOpen: (card) => {
      const group = rows.get(featureCardKey(card));
      const thread = group ? workGroupOpenThread(group) : null;
      if (!thread) {
        if (!actions.openCard(card))
          toastManager.add({ type: "info", title: "This feature has no thread to open yet" });
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: thread.environmentId, threadId: thread.id },
      });
    },
    onMenu: (card: EnvironmentFeatureCard, event: MouseEvent) =>
      void actions.showMenu(card, { x: event.clientX, y: event.clientY }),
    onAction: (card, action) => void actions.run(card, action),
    onShelf: toggleShelf,
    canShelf: (card) => rowFor(card).length > 0,
    onDrop: (card, action, position) => {
      if (action === "settle") toggleShelf(card);
      else if (action === "cancel") void actions.run(card, "cancel");
      else void actions.reopenFromDrop(card, position);
    },
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
    onStartTodo: (issue) =>
      void startFeatureFromTodo(issue, issueBoard.tickets.get(issueKey(issue))?.description),
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
        input: {},
      });
      if (result._tag !== "Success") return;
    }
    await newThread(scopeProjectRef(newFeatureProject.environmentId, newFeatureProject.id));
  };
  const browseWorkflows = () => void navigate({ to: "/library", search: {} });
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
  const newTodoShortcut = shortcutLabelForCommand(keybindings, "features.newTodo", {
    context: { featuresPageOpen: true },
  });

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
    } else newTodo();
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

  const firstRun =
    board.loaded &&
    board.errors.length === 0 &&
    board.cards.length === 0 &&
    !issueBoard.pending &&
    issueBoard.issues.every((issue) => issue.state !== "open") &&
    !query;

  const clearFilters = () => {
    setLabelFilters(new Set());
    props.onSearchChange({ project: undefined, milestone: undefined });
  };
  const showProjectInTitles = scopedProject === null && projects.length > 1;
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
              props.onSearchChange({ project: checked ? value : undefined }),
          },
        ]
      : []),
    ...(issueBoard.milestones.length > 0 || milestoneFilter
      ? [
          {
            label: "Milestone",
            options: issueBoard.milestones.map((milestone) => ({
              value: issueKey(milestone),
              label: showProjectInTitles
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

  const headerActions = (
    <div className="ms-auto flex min-w-0 items-center gap-1">
      <MainViewToggle />
      {searchOpen || query ? (
        <InputGroup className="w-44 md:w-60">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchInputRef}
            type="search"
            autoFocus
            aria-label="Search the board"
            placeholder="Search, #number, or workflow:bug-fix"
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
      <BoardDisplayMenu
        layout={layout}
        onLayout={(featureLayout) => updatePreferences({ featureLayout })}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Refresh issues"
        title={
          issueBoard.readAt
            ? `Issues read from GitHub ${formatRelativeTimeLabel(issueBoard.readAt)}`
            : "Refresh issues"
        }
        disabled={issueBoard.refreshing}
        onClick={issueBoard.refresh}
      >
        <RefreshCwIcon aria-hidden />
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button size="sm" disabled={!newFeatureProject}>
              <PlusIcon aria-hidden />
              <span className="hidden md:inline">New</span>
            </Button>
          }
        />
        <MenuPopup align="end">
          <MenuItem onClick={newTodo}>
            New todo
            {newTodoShortcut ? <MenuShortcut>{newTodoShortcut}</MenuShortcut> : null}
          </MenuItem>
          <MenuItem onClick={() => void startNewFeature(false)}>New feature</MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );

  let body;
  // The board fills the page and scrolls each column; everything else scrolls the page.
  let lanes = false;
  if (projects.length === 0) {
    body = (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Connect an environment that runs workflows to see features.
      </p>
    );
  } else if (firstRun) {
    body = (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-5 py-14 text-center">
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-lg font-medium">Nothing on the board yet</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Add a todo, then start a feature from it. Your crew takes it through a workflow, and
            anything that needs your approval waits under Needs you.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={newTodo} disabled={!newFeatureProject}>
            New todo
          </Button>
          <Button
            variant="outline"
            onClick={() => void startNewFeature(true)}
            disabled={!newFeatureProject}
          >
            Start a feature
          </Button>
          <Button variant="ghost" onClick={browseWorkflows}>
            Browse workflows
          </Button>
        </div>
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
  } else {
    lanes = layout === "board";
    body = (
      <FeatureStatusBoard
        layout={layout}
        groups={groups}
        todos={todos}
        settled={settledCards}
        handlers={handlers}
      />
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
      {issueBoard.truncated ? (
        <p className="text-xs text-muted-foreground">
          Todo shows the 100 most recently updated open issues per project. Search narrows them.
        </p>
      ) : null}
      {body}
    </>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="text-sm font-medium">Board</h1>
          {firstRun ? (
            <div className="ms-auto flex items-center">
              <MainViewToggle />
            </div>
          ) : (
            headerActions
          )}
        </WorkspacePageHeader>
        {lanes ? (
          <WorkspacePageContainer width="full" className="min-h-0 flex-1 gap-3 pb-3">
            {content}
          </WorkspacePageContainer>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer width="full" className="gap-3">
              {content}
            </WorkspacePageContainer>
          </ScrollArea>
        )}
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
