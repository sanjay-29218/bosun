import { use } from "react";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { logicalBotProjectKeys } from "@t3tools/client-runtime/state/bot-rail";
import { headquartersBotId } from "@t3tools/contracts";
import { resolveScratchProjectScopeKey } from "@t3tools/client-runtime/state/project-grouping";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
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
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { checkForAppUpdateOnLaunch, startAppUpdateForegroundRecheck } from "../updates/app-updates";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { useAtomValueWhileVisible, useHomeRouteVisible } from "./home-route-visibility";
import { useHomeThreadSelection } from "./home-thread-navigation";
import { BotHeaderRow } from "./BotHeaderRow";
import { useOpenBotHeadquarters } from "./useOpenBotHeadquarters";
import { buildHomeProjectScopes, findHomeProjectScope } from "./homeThreadList";
import { buildBotSwitcherMenu } from "./thread-list-chrome";
import { useThreadListView } from "./use-thread-list-view";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { getConnectionAwareBrandHeaderOptions } from "./WorkspaceConnectionTitle";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const { width: windowWidth } = useWindowDimensions();
  const nativePrimaryColumn = use(NativePrimaryColumnContext);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const headerWidth = nativePrimaryColumn ? (columnMetrics?.width ?? windowWidth) : windowWidth;
  const { layout, panes, primarySidebarSearchQuery, setPrimarySidebarSearchQuery } =
    useAdaptiveWorkspaceLayout();
  const allProjects = useProjects();
  // Streaming turns rewrite thread shells many times a second. While a Thread
  // covers Home, rebuilding this list is invisible work.
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
  const handleSelectThread = useHomeThreadSelection();
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
      }),
    [activeBot, openHeadquarters],
  );
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
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
  const boardProjects = useBoardProjects(botProjectKeys);
  const viewToggle = useThreadListView(activeBot.viewKey, boardProjects.length > 0);
  const handleNewThreadOnBranch = useCallback(
    (thread: EnvironmentThreadShell) => {
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(thread.environmentId),
          projectId: String(thread.projectId),
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        },
      });
    },
    [navigation],
  );

  useEffect(() => {
    void checkForAppUpdateOnLaunch();
    startAppUpdateForegroundRecheck();
  }, []);

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
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(() => {
    const connectionStateByEnvironmentId = new Map(
      workspaceEnvironments.map(
        (environment) => [environment.environmentId, environment.connectionState] as const,
      ),
    );
    return Arr.sort(
      Object.values(savedConnectionsById).map((connection) => ({
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        connectionState:
          connectionStateByEnvironmentId.get(connection.environmentId) ?? "available",
      })),
      Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
    );
  }, [savedConnectionsById, workspaceEnvironments]);
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
  const projectScopeKey = listOptions.selectedProjectKey;
  const resolvedProjectKey = resolveScratchProjectScopeKey(projectScopeKey, projects, {
    sidebarProjectGroupingMode: listOptions.projectGroupingMode,
    sidebarProjectGroupingOverrides: {},
  });
  useEffect(() => {
    if (resolvedProjectKey !== projectScopeKey) {
      setSelectedProjectKey(resolvedProjectKey);
    }
  }, [projectScopeKey, resolvedProjectKey, setSelectedProjectKey]);
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
  // A saved project stays selected while its environment is offline or filtered out.
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

  // In split layouts the persistent sidebar IS the thread list — Home becomes
  // an empty detail pane so selecting a thread never transitions layouts.
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
                  // Options survive layout changes; search and settings now belong to the sidebar.
                  headerSearchBarOptions: undefined,
                  unstable_headerRightItems: () => [],
                  unstable_headerToolbarItems: () => [],
                }
          }
        />
        {Platform.OS === "ios" ? (
          <NativeHeaderToolbar placement="left">
            <NativeHeaderToolbar.Button
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
            />
          </NativeHeaderToolbar>
        ) : null}
        {Platform.OS === "android" ? <AndroidScreenHeader title="Threads" /> : null}
        <WorkspaceEmptyDetail
          onAddConnection={
            Platform.OS === "android" && !catalogState.hasConnections
              ? () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsEnvironmentNew" },
                  })
              : undefined
          }
          onStartNewTask={
            Platform.OS === "android" && panes.primarySidebarVisible
              ? undefined
              : () => navigation.navigate("NewTaskSheet", { screen: "NewTask" })
          }
        />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout
      disabled={workspace !== null && Platform.OS !== "android"}
      onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
    >
      <>
        {/* Restore the header after leaving split view; screen options are
            shallow-merged. The brand slot also doubles as the connection
            status surface while an environment reconnects. */}
        {workspace !== null && Platform.OS === "ios" ? null : (
          <NativeStackScreenOptions
            optionsVersion={[headerWidth, botSwitcher !== null, viewToggle !== null]}
            options={{
              ...getConnectionAwareBrandHeaderOptions({
                headerWidth,
                trailingItemCount:
                  (nativePrimaryColumn && Platform.OS === "ios" && Platform.isPad ? 2 : 1) +
                  (botSwitcher ? 1 : 0) +
                  (viewToggle ? 1 : 0),
                onOpenEnvironments: () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsEnvironments" },
                  }),
              }),
              headerShown: Platform.OS !== "android",
            }}
          />
        )}
        <HomeHeader
          usesWorkspaceToolbar={workspace !== null}
          environments={environments}
          projects={projectFilterOptions}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenEnvironments={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsEnvironments" },
            })
          }
          onOpenSettings={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            })
          }
          botSwitcher={botSwitcher}
          viewToggle={viewToggle}
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
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
            onStartFeature={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
          />
        ) : (
          <HomeScreen
            botHeader={botHeader}
            catalogState={catalogState}
            environments={environments}
            onAddConnection={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsEnvironmentNew" },
              })
            }
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
            onOpenSettings={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "Settings" },
              })
            }
            onSearchQueryChange={setSearchQuery}
            onSelectThread={handleSelectThread}
            onSelectPendingTask={openPendingTask}
            onDeletePendingTask={confirmDeletePendingTask}
            onNewThreadOnBranch={handleNewThreadOnBranch}
            onNewThreadInProject={(project) => {
              navigation.navigate("NewTaskSheet", {
                screen: "NewTaskDraft",
                params: {
                  environmentId: String(project.environmentId),
                  projectId: String(project.id),
                  title: project.title,
                },
              });
            }}
            onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
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
      </>
    </AndroidHomeFabLayout>
  );
}
