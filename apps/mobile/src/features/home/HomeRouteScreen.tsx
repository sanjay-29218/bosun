import { uuidv4 } from "../../lib/uuid";
import { ThreadUndoNotice } from "./ThreadUndoNotice";
import { Toolbar } from "../../components/ui/Toolbar";
import { use } from "react";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { logicalBotProjectKeys } from "@t3tools/client-runtime/state/bot-rail";
import { headquartersBotId } from "@t3tools/contracts";
import { resolveScratchProjectScopeKey } from "@t3tools/client-runtime/state/project-grouping";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useActiveBot, useRefreshBotsWhileOpen } from "../../state/bots";
import { useProjects } from "../../state/entities";
import { useBoardProjects } from "../../state/features";
import { FeatureBoard } from "../crew/FeatureBoard";
import { environmentThreadShells } from "../../state/threads";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useDeviceType, useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { useAtomValueWhileVisible, useHomeRouteVisible } from "./home-route-visibility";
import { BotHeaderRow } from "./BotHeaderRow";
import { useOpenBotHeadquarters } from "./useOpenBotHeadquarters";
import { buildHomeProjectScopes, findHomeProjectScope } from "./homeThreadList";
import { buildBotSwitcherMenu } from "./thread-list-chrome";
import { useThreadListView } from "./use-thread-list-view";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { getConnectionAwareBrandHeaderOptions } from "./WorkspaceConnectionTitle";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { openSettings } from "../settings/settings-navigation";
import { useSelectWorkspaceTab } from "../workspace/useSelectWorkspaceTab";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

export function HomeRouteScreen() {
  const { width: windowWidth } = useWindowDimensions();
  const nativePrimaryColumn = use(NativePrimaryColumnContext);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const deviceType = useDeviceType();
  const headerWidth = nativePrimaryColumn ? (columnMetrics?.width ?? windowWidth) : windowWidth;
  const { layout, panes, primarySidebarSearchQuery, setPrimarySidebarSearchQuery, startNewTask } =
    useAdaptiveWorkspaceLayout();
  const selectDetail = useSelectWorkspaceDetail();
  const allProjects = useProjects();
  // Stop rebuilding the streaming thread list while Thread covers Home.
  const visible = useHomeRouteVisible();
  const allThreads = useAtomValueWhileVisible(
    environmentThreadShells.navigationThreadShellsAtom,
    visible,
  );
  // The list shows the active bot's projects; with one bot it shows everything.
  const activeBot = useActiveBot();
  useRefreshBotsWhileOpen();
  const botProjectKeys = activeBot.projectKeys;
  const projects = useMemo(
    () =>
      botProjectKeys === null
        ? allProjects
        : allProjects.filter((project) =>
            botProjectKeys.has(scopedProjectKey(project.environmentId, project.id)),
          ),
    [allProjects, botProjectKeys],
  );
  // Headquarters open from the bot row above the list instead.
  const threads = useMemo(
    () =>
      allThreads.filter(
        (thread) =>
          headquartersBotId(thread.id) === null &&
          (botProjectKeys === null ||
            botProjectKeys.has(scopedProjectKey(thread.environmentId, thread.projectId))),
      ),
    [allThreads, botProjectKeys],
  );
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const selectTab = useSelectWorkspaceTab();
  const workspace = useWorkspaceTabs();
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const searchQuery =
    Platform.OS === "android"
      ? primarySidebarSearchQuery
      : (workspace?.state.tabs.threads.query ?? localSearchQuery);
  const setSearchQuery = (query: string) => {
    if (Platform.OS === "android") setPrimarySidebarSearchQuery(query);
    else if (workspace) workspace.dispatch({ type: "query", query, tab: "threads" });
    else setLocalSearchQuery(query);
  };
  const handleSelectThread = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
    selectDetail({
      name: "Thread",
      params: { environmentId: String(thread.environmentId), threadId: String(thread.id) },
    });
  const openHeadquarters = useOpenBotHeadquarters(handleSelectThread);
  const botProjectCount = useMemo(
    () =>
      activeBot.active === null
        ? 0
        : logicalBotProjectKeys(
            activeBot.active,
            activeBot.bots,
            allProjects.filter((project) => !project.isScratch),
          ).size,
    [activeBot.active, activeBot.bots, allProjects],
  );
  const botHeader = activeBot.active ? (
    <BotHeaderRow
      bot={activeBot.active}
      threads={allThreads}
      projectCount={botProjectCount}
      onOpen={(bot) => void openHeadquarters(bot)}
    />
  ) : null;
  const botSwitcher = useMemo(
    () =>
      buildBotSwitcherMenu({
        ...activeBot,
        openHeadquarters: (bot) => void openHeadquarters(bot),
        openAutomations: () => openSettings(navigation, "SettingsScheduledTasks"),
        openLibrary: () => openSettings(navigation, "SettingsWorkflows"),
      }),
    [activeBot, navigation, openHeadquarters],
  );
  const boardProjects = useBoardProjects(botProjectKeys);
  const viewToggle = useThreadListView(activeBot.viewKey, boardProjects.length > 0);
  const selectThreadRoute = (params: ReactNavigation.RootParamList["Thread"]) =>
    selectDetail({ name: "Thread", params });
  const handleNewThreadOnBranch = (thread: EnvironmentThreadShell) => {
    selectThreadRoute({
      draft: {
        requestId: uuidv4(),
        environmentId: String(thread.environmentId),
        projectId: String(thread.projectId),
        branch: thread.branch,
        worktreePath: thread.worktreePath,
      },
    });
  };

  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    moveThread,
    renameThread,
    regenerateThreadTitle,
    unsettleThread,
  } = useThreadListActions();
  const allPendingTasks = usePendingNewTasks();
  const pendingTasks = useMemo(
    () =>
      botProjectKeys === null
        ? allPendingTasks
        : allPendingTasks.filter((task) =>
            botProjectKeys.has(scopedProjectKey(task.environmentId, task.projectId)),
          ),
    [allPendingTasks, botProjectKeys],
  );
  const { openPendingTask, confirmDeletePendingTask } =
    usePendingTaskListActions(selectThreadRoute);
  const connectionStateByEnvironmentId = new Map(
    workspaceEnvironments.map(
      (environment) => [environment.environmentId, environment.connectionState] as const,
    ),
  );
  const environments = Arr.sort(
    Object.values(savedConnectionsById).map((connection) => ({
      environmentId: connection.environmentId,
      label: connection.environmentLabel,
      connectionState: connectionStateByEnvironmentId.get(connection.environmentId) ?? "available",
    })),
    Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
  );
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const {
    options: listOptions,
    setSelectedEnvironmentId,
    setSelectedProjectKey,
  } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  // A legacy per-environment scratch key resolves here on every render; the stored
  // value is only rewritten when the user picks a filter.
  const resolvedProjectKey = resolveScratchProjectScopeKey(
    listOptions.selectedProjectKey,
    projects,
    {
      sidebarProjectGroupingMode: listOptions.projectGroupingMode,
      sidebarProjectGroupingOverrides: {},
    },
  );
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: selectedEnvironmentId,
        projectGroupingMode: listOptions.projectGroupingMode,
      }),
    [listOptions.projectGroupingMode, projects, selectedEnvironmentId],
  );
  const projectFilterOptions = useMemo(
    () => projectScopes.map((scope) => ({ key: scope.key, label: scope.title })),
    [projectScopes],
  );
  const selectedProjectKey = projectFilterOptions.some(
    (project) => project.key === resolvedProjectKey,
  )
    ? resolvedProjectKey
    : null;
  // The board follows the same environment and project filters as the list.
  const filteredBoardProjects = useMemo(() => {
    const scope = findHomeProjectScope(projectScopes, selectedProjectKey);
    const scopeKeys =
      scope === null
        ? null
        : new Set(
            scope.projectRefs.map((ref) => scopedProjectKey(ref.environmentId, ref.projectId)),
          );
    return boardProjects.filter(
      (project) =>
        (selectedEnvironmentId === null || project.environmentId === selectedEnvironmentId) &&
        (scopeKeys === null || scopeKeys.has(scopedProjectKey(project.environmentId, project.id))),
    );
  }, [boardProjects, projectScopes, selectedEnvironmentId, selectedProjectKey]);

  if (layout.usesSplitView && !nativePrimaryColumn) {
    return (
      <>
        <NativeStackScreenOptions
          options={
            Platform.OS === "android"
              ? { headerShown: false }
              : {
                  title: "",
                  headerTitle: "",
                  unstable_headerLeftItems: () => [],
                  headerSearchBarOptions: undefined,
                  unstable_headerRightItems: () => [],
                  unstable_headerToolbarItems: () => [],
                }
          }
        />
        {Platform.OS === "ios" ? (
          <Toolbar placement="left">
            <Toolbar.Button
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={startNewTask}
            />
          </Toolbar>
        ) : null}
        {Platform.OS === "android" ? <AndroidScreenHeader title="Threads" /> : null}
        <WorkspaceEmptyDetail
          onAddConnection={
            Platform.OS === "android" && !catalogState.hasConnections
              ? () => openSettings(navigation, "SettingsEnvironmentNew")
              : undefined
          }
          onStartNewTask={
            Platform.OS === "android" && panes.primarySidebarVisible ? undefined : startNewTask
          }
        />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout
      disabled={workspace !== null && Platform.OS !== "android"}
      onStartNewTask={startNewTask}
    >
      <>
        {/* Screen options merge shallowly; restore the header after split view. */}
        {workspace !== null && Platform.OS === "ios" ? null : (
          <NativeStackScreenOptions
            optionsVersion={[headerWidth, botSwitcher !== null, viewToggle !== null]}
            options={{
              ...getConnectionAwareBrandHeaderOptions({
                headerWidth,
                trailingItemCount:
                  (nativePrimaryColumn && deviceType === "pad" ? 2 : 1) +
                  (botSwitcher ? 1 : 0) +
                  (viewToggle ? 1 : 0),
                onOpenEnvironments: () => openSettings(navigation, "SettingsEnvironments"),
              }),
              headerShown: Platform.OS !== "android",
            }}
          />
        )}
        <HomeHeader
          environments={environments}
          projects={projectFilterOptions}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenEnvironments={() => openSettings(navigation, "SettingsEnvironments")}
          onOpenSettings={() => selectTab("settings")}
          botSwitcher={botSwitcher}
          viewToggle={viewToggle}
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={startNewTask}
        />

        {viewToggle?.view === "board" ? (
          <FeatureBoard
            projects={filteredBoardProjects}
            threads={threads}
            active={visible}
            searchQuery={searchQuery}
            scopeKey={`${activeBot.viewKey}|${selectedEnvironmentId ?? "all"}|${selectedProjectKey ?? "all"}`}
            onOpenThread={(environmentId, threadId) =>
              handleSelectThread({ environmentId, id: threadId })
            }
            onStartFeature={startNewTask}
          />
        ) : (
          <HomeScreen
            botHeader={botHeader}
            catalogState={catalogState}
            environments={environments}
            onAddConnection={() => openSettings(navigation, "SettingsEnvironmentNew")}
            onArchiveThread={archiveThread}
            onDeleteThread={confirmDeleteThread}
            onSettleThread={settleThread}
            onSnoozeThread={snoozeThread}
            onUnsnoozeThread={unsnoozeThread}
            onUnsettleThread={unsettleThread}
            onPinThread={pinThread}
            onUnpinThread={unpinThread}
            onSetThreadAutoSettle={setThreadAutoSettle}
            onMoveThread={moveThread}
            onRenameThread={renameThread}
            onRegenerateThreadTitle={regenerateThreadTitle}
            onEnvironmentChange={setSelectedEnvironmentId}
            onProjectChange={setSelectedProjectKey}
            onOpenSettings={() => selectTab("settings")}
            onSearchQueryChange={setSearchQuery}
            onSelectThread={handleSelectThread}
            onSelectPendingTask={openPendingTask}
            onDeletePendingTask={confirmDeletePendingTask}
            onNewThreadOnBranch={handleNewThreadOnBranch}
            onNewThreadInProject={(project) => {
              selectThreadRoute({
                draft: {
                  requestId: uuidv4(),
                  environmentId: String(project.environmentId),
                  projectId: String(project.id),
                  title: project.title,
                },
              });
            }}
            onStartNewTask={startNewTask}
            pendingTasks={pendingTasks}
            projectGroupingMode={listOptions.projectGroupingMode}
            projects={projects}
            projectSortOrder={listOptions.projectSortOrder}
            savedConnectionsById={savedConnectionsById}
            searchQuery={searchQuery}
            selectedEnvironmentId={selectedEnvironmentId}
            selectedProjectKey={selectedProjectKey}
            threads={threads}
          />
        )}
        <ThreadUndoNotice visible={visible} />
      </>
    </AndroidHomeFabLayout>
  );
}
