import { useAtomValue } from "@effect/atom-react";
import { selectLogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import { EnvironmentId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { logicalBotsAtom, readActiveLogicalBotKey } from "../../state/botRail";
import { useProjects } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { followStandingThread, standingThreadSelection } from "./standingThreadSelection";

/**
 * Keeps the rail on the open standing thread when it was opened from outside the rail (a link,
 * Settings, the palette, a reload): a bot's headquarters picks its bot, a project manager its
 * project's bot and project.
 */
export function FollowStandingThread() {
  const environmentId = useParams({ strict: false, select: (params) => params.environmentId });
  const threadId = useParams({ strict: false, select: (params) => params.threadId });
  const bots = useAtomValue(logicalBotsAtom);
  const projects = useProjects();
  const groups = useSettingsProjectGroups();
  const followedRef = useRef<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the rail's pick follows a standing thread opened outside it, once per opened thread and only after its bot and project load, so it never fights a later pick.
  useEffect(() => {
    const key = environmentId && threadId ? `${environmentId}:${threadId}` : null;
    if (key === followedRef.current) return;
    if (environmentId === undefined || threadId === undefined) {
      followedRef.current = null;
      return;
    }
    const selection = standingThreadSelection({
      environmentId: EnvironmentId.make(environmentId),
      threadId,
      bots,
      projects,
      projectKeyOf: (projectEnvironmentId, projectId) =>
        groups.find((group) =>
          group.memberProjects.some(
            (member) => member.environmentId === projectEnvironmentId && member.id === projectId,
          ),
        )?.projectKey ?? null,
    });
    if (selection.kind === "pending") return;
    followedRef.current = key;
    if (selection.kind === "none") return;
    const bot = bots.find((candidate) => candidate.key === selection.botKey);
    if (!bot) return;
    const store = useUiStateStore.getState();
    const change = followStandingThread(
      { activeBotKey: readActiveLogicalBotKey(), scopeKeys: store.sidebarProjectScopeKeys },
      selection,
    );
    // Picking another bot clears the scope, so the project's scope is set after it.
    if (change.selectBot) store.setActiveBotIdByEnvironmentId(selectLogicalBot(bot));
    if (change.scopeKeys !== null) {
      useUiStateStore.getState().setSidebarProjectScopeKeys(change.scopeKeys);
    }
  }, [environmentId, threadId, bots, projects, groups]);

  return null;
}
