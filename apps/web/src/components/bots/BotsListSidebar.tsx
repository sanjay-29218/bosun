import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BotActivity, LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import {
  botHeadquartersThreadId,
  projectHeadquartersThreadId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, PinIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import {
  useActivityByLogicalBot,
  useAllVisibleLogicalBots,
  useEnvironmentFilter,
  useNeedsYouByLogicalBot,
  useShownBotEnvironmentIds,
} from "../../state/botRail";
import { botsEnvironment } from "../../state/bots";
import { useProjects } from "../../state/entities";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  useEnvironments,
} from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { searchableSetting } from "../settings/settingsSearch";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { leaveRailOnStandingOpen } from "../sidebar/FollowStandingThread";
import { BOTS_SETTINGS_PATH } from "../sidebar/mainAppLocation";
import { headquartersMember, useOpenBotHeadquarters } from "../sidebar/openBotHeadquarters";
import { useOpenProjectManager } from "../sidebar/openProjectManager";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { useStandingStatus } from "../sidebar/useStandingStatus";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { ProjectManagerAvatar, useProjectManagerIcon } from "./ProjectManagerIcon";
import {
  botProjectsLabel,
  botsListManagers,
  managerSubtitle,
  type BotsListManager,
} from "./botsList.logic";

/**
 * The sidebar column on the Bots destination: every bot, then every project manager, each with
 * a pin that keeps it in the main rail. A row opens its thread and leaves the rail as it is.
 */
export function BotsListSidebar() {
  const bots = useAllVisibleLogicalBots();
  const needsYou = useNeedsYouByLogicalBot();
  const activity = useActivityByLogicalBot();
  const projects = useProjects();
  const groups = useSettingsProjectGroups();
  const { environments } = useEnvironments();
  const identities = useEnvironmentIdentities();
  const environmentFilter = useEnvironmentFilter();
  const botEnvironmentIds = useShownBotEnvironmentIds();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const pin = usePinToggle();

  const creationEnvironmentId = botEnvironmentIds[0] ?? null;
  const canCreate = useAtomValue(botsEnvironment.create.permissionAtom(creationEnvironmentId));
  const managerEnvironmentIds = new Set(
    environments
      .filter(
        (environment) => environment.serverConfig?.environment.capabilities.workflows === true,
      )
      .map((environment) => environment.environmentId),
  );
  const shownProjects =
    environmentFilter === null
      ? projects
      : projects.filter((project) => environmentFilter.has(project.environmentId));
  const managers = botsListManagers({
    projects: shownProjects,
    bots,
    managerEnvironmentIds,
    projectKeyOf: (environmentId, projectId) =>
      groups.find((group) =>
        group.memberProjects.some(
          (member) => member.environmentId === environmentId && member.id === projectId,
        ),
      )?.projectKey ?? null,
  });
  const botNames = new Map(bots.map((bot) => [bot.key, bot.name]));
  const labelById = new Map(identities.map((identity) => [identity.environmentId, identity.label]));
  const severalEnvironments = new Set(managers.map((manager) => manager.environmentId)).size > 1;

  const close = () => {
    if (isMobile) setOpenMobile(false);
  };
  const createBot = () => {
    if (creationEnvironmentId === null) return;
    close();
    void navigate({
      to: BOTS_SETTINGS_PATH,
      search: { environmentId: creationEnvironmentId, new: true },
    });
  };

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <div className="flex items-center gap-1">
              <h2 className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-sm font-medium text-sidebar-foreground">
                <BotIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
                Bots
              </h2>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={!canCreate || creationEnvironmentId === null}
                onClick={createBot}
              >
                <PlusIcon />
                Add bot
              </Button>
            </div>
          </SidebarGroup>
        }
      >
        <SidebarGroup>
          <div className="flex flex-col gap-4">
            {botEnvironmentIds.map((environmentId) => (
              <BotsLoadError
                key={environmentId}
                environmentId={environmentId}
                label={labelById.get(environmentId) ?? "an environment"}
              />
            ))}
            {bots.length === 0 ? (
              <Empty size="compact">
                <EmptyHeader>
                  <EmptyTitle>No bots yet</EmptyTitle>
                  <EmptyDescription>
                    A bot runs your projects and talks to you in its own thread.
                  </EmptyDescription>
                </EmptyHeader>
                <Button
                  size="sm"
                  disabled={!canCreate || creationEnvironmentId === null}
                  onClick={createBot}
                >
                  Create a bot
                </Button>
              </Empty>
            ) : (
              <Section title="Bots">
                {bots.map((bot) => (
                  <BotsListBotRow
                    key={bot.key}
                    bot={bot}
                    subtitle={botProjectsLabel(bot, bots, projects)}
                    needsYou={needsYou.get(bot.key) ?? 0}
                    activity={activity.get(bot.key)}
                    pinned={pin.shown(bot.key, bot.pinned)}
                    onTogglePin={() =>
                      pin.toggle(
                        bot.key,
                        bot.name,
                        !pin.shown(bot.key, bot.pinned),
                        bot.members.map((member) => ({
                          environmentId: member.environmentId,
                          input: { botId: member.botId },
                        })),
                      )
                    }
                    onNavigate={close}
                  />
                ))}
              </Section>
            )}
            {managers.length === 0 ? null : (
              <Section title="Project managers">
                {managers.map((manager) => (
                  <BotsListManagerRow
                    key={manager.key}
                    manager={manager}
                    subtitle={managerSubtitle(
                      manager.ownerKey === null ? null : (botNames.get(manager.ownerKey) ?? null),
                      severalEnvironments ? (labelById.get(manager.environmentId) ?? null) : null,
                    )}
                    pinned={pin.shown(manager.key, manager.pinned)}
                    onTogglePin={() =>
                      pin.toggle(
                        manager.key,
                        manager.title,
                        !pin.shown(manager.key, manager.pinned),
                        [
                          {
                            environmentId: manager.environmentId,
                            input: { projectId: manager.projectId },
                          },
                        ],
                      )
                    }
                    onNavigate={close}
                  />
                ))}
              </Section>
            )}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

/** Pins show the new state at once and fall back, with a toast, if the server refuses. */
function usePinToggle() {
  const setPin = useAtomCommand(botsEnvironment.setPin, { reportFailure: false });
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map());
  const settle = (key: string) =>
    setPending((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  return {
    shown: (key: string, pinned: boolean) => pending.get(key) ?? pinned,
    toggle: (
      key: string,
      name: string,
      pinned: boolean,
      targets: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly input:
          | { readonly botId: string }
          | { readonly projectId: BotsListManager["projectId"] };
      }>,
    ) => {
      setPending((current) => new Map(current).set(key, pinned));
      void Promise.all(
        targets.map((target) =>
          setPin({ environmentId: target.environmentId, input: { ...target.input, pinned } }),
        ),
      ).then((results) => {
        settle(key);
        const failure = results.find((result) => result._tag !== "Success");
        if (failure !== undefined && failure._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: `Could not pin ${name}`,
            description: formatEnvironmentQueryError(failure.cause),
          });
        }
      });
    },
  };
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}

function BotsLoadError({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const query = useEnvironmentQuery(botsEnvironment.list({ environmentId, input: {} }));
  if (!query.error) return null;
  return (
    <p className="px-2 text-xs text-muted-foreground" role="status">
      Could not load bots on {label}.
    </p>
  );
}

function ListRow({
  name,
  subtitle,
  avatar,
  mark,
  pinned,
  dimmed = false,
  onOpen,
  onSettings,
  onTogglePin,
}: {
  readonly name: string;
  readonly subtitle: string;
  readonly avatar: ReactNode;
  readonly mark: { readonly needsYou: number } | "working" | null;
  readonly pinned: boolean;
  readonly dimmed?: boolean;
  readonly onOpen: () => void;
  readonly onSettings: (() => void) | null;
  readonly onTogglePin: () => void;
}) {
  return (
    <li
      className={cn(
        "group/row relative flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-sidebar-row-hover",
        dimmed && "opacity-60",
      )}
    >
      <button
        type="button"
        aria-label={`Open ${name}`}
        className="absolute inset-0 cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onOpen}
      />
      <span className="pointer-events-none shrink-0">{avatar}</span>
      <span className="pointer-events-none flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-sidebar-foreground">{name}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          {mark === "working" ? (
            <span className="size-1.5 shrink-0 rounded-full bg-info">
              <span className="sr-only">Working</span>
            </span>
          ) : mark !== null && mark.needsYou > 0 ? (
            <span className="shrink-0 rounded-sm bg-warning px-1 text-2xs leading-4 font-semibold text-black tabular-nums">
              {mark.needsYou}
              <span className="sr-only"> need you</span>
            </span>
          ) : null}
          <span className="min-w-0 truncate text-xs text-muted-foreground">{subtitle}</span>
        </span>
      </span>
      {onSettings ? (
        <span className="relative opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label={`${name} settings`}
            onClick={onSettings}
          >
            <SettingsIcon />
          </Button>
        </span>
      ) : null}
      <span className="relative">
        <Button
          variant={pinned ? "ghost" : "ghost-muted"}
          size="icon-xs"
          aria-pressed={pinned}
          aria-label={pinned ? `Unpin ${name} from rail` : `Pin ${name} to rail`}
          onClick={onTogglePin}
        >
          <PinIcon className={cn(pinned && "fill-current")} />
        </Button>
      </span>
    </li>
  );
}

const BotsListBotRow = memo(function BotsListBotRow({
  bot,
  subtitle,
  needsYou,
  activity,
  pinned,
  onTogglePin,
  onNavigate,
}: {
  readonly bot: LogicalBot;
  readonly subtitle: string;
  readonly needsYou: number;
  readonly activity: BotActivity | undefined;
  readonly pinned: boolean;
  readonly onTogglePin: () => void;
  readonly onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const openHeadquarters = useOpenBotHeadquarters();
  const connected = useConnectedEnvironmentIds();
  const environmentFilter = useEnvironmentFilter();
  const member = headquartersMember(bot, connected, environmentFilter);
  const editMember = member ?? bot.members[0];
  return (
    <ListRow
      name={bot.name}
      subtitle={member === undefined ? "Offline" : subtitle}
      dimmed={member === undefined}
      avatar={
        <BotAvatar
          avatar={bot.avatar}
          color={bot.color}
          size={32}
          working={needsYou === 0 && activity?.working === true}
        />
      }
      mark={needsYou > 0 ? { needsYou } : activity?.working ? "working" : null}
      pinned={pinned}
      onOpen={() => {
        if (member === undefined) return;
        onNavigate();
        leaveRailOnStandingOpen(member.environmentId, botHeadquartersThreadId(member.botId));
        openHeadquarters(bot);
      }}
      onSettings={
        editMember
          ? () => {
              onNavigate();
              void navigate({
                to: BOTS_SETTINGS_PATH,
                search: { environmentId: editMember.environmentId, botId: editMember.botId },
              });
            }
          : null
      }
      onTogglePin={onTogglePin}
    />
  );
});

const BotsListManagerRow = memo(function BotsListManagerRow({
  manager,
  subtitle,
  pinned,
  onTogglePin,
  onNavigate,
}: {
  readonly manager: BotsListManager;
  readonly subtitle: string;
  readonly pinned: boolean;
  readonly onTogglePin: () => void;
  readonly onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const openProjectManager = useOpenProjectManager();
  const threadId = projectHeadquartersThreadId(manager.projectId);
  const { waiting, working } = useStandingStatus(scopeThreadRef(manager.environmentId, threadId));
  const icon = useProjectManagerIcon(manager.environmentId, manager.projectId);
  return (
    <ListRow
      name={manager.title}
      subtitle={subtitle}
      avatar={
        <ProjectManagerAvatar
          projectId={manager.projectId}
          icon={icon}
          size={32}
          working={working}
        />
      }
      mark={waiting ? { needsYou: 1 } : working ? "working" : null}
      pinned={pinned}
      onOpen={() => {
        onNavigate();
        leaveRailOnStandingOpen(manager.environmentId, threadId);
        void openProjectManager(manager);
      }}
      onSettings={() => {
        onNavigate();
        void navigate({
          to: "/settings/projects",
          search: { project: manager.projectKey },
          hash: searchableSetting("project-manager").id,
        });
      }}
      onTogglePin={onTogglePin}
    />
  );
});
