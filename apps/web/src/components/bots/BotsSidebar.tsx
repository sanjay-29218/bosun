import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "@effect/atom-react";
import type { Bot, EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { BotIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { botsEnvironment } from "../../state/bots";
import { useShownBotEnvironmentIds } from "../../state/botRail";
import { useProjects } from "../../state/entities";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { BOTS_PATH } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { groupProjectsByBot, moveBotTo } from "./bots.logic";

/** The sidebar column on the Bots destination: each shown environment's bots, in rail order. */
export function BotsSidebar() {
  const environmentIds = useShownBotEnvironmentIds();
  const identities = useEnvironmentIdentities();
  const connected = useConnectedEnvironmentIds();
  const labelById = new Map(identities.map((identity) => [identity.environmentId, identity.label]));

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <h2 className="flex h-8 min-w-0 items-center gap-2 px-2 text-sm font-medium text-sidebar-foreground">
              <BotIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
              Bots
            </h2>
          </SidebarGroup>
        }
      >
        <SidebarGroup>
          <div className="flex flex-col gap-4">
            {environmentIds.length === 0 ? (
              <p className="px-2 text-xs text-muted-foreground">
                {connected.length === 0
                  ? "No environments connected"
                  : "No connected environment runs bots"}
              </p>
            ) : (
              environmentIds.map((environmentId) => (
                <EnvironmentBots
                  key={environmentId}
                  environmentId={environmentId}
                  title={
                    environmentIds.length > 1
                      ? (labelById.get(environmentId) ?? "Environment")
                      : "Your bots"
                  }
                />
              ))
            )}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

// Pointer only: rows are links, so Enter opens a bot. The bot's menu moves it by keyboard.
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } };
const DND_MODIFIERS = [restrictToVerticalAxis];

/** One environment's bots, dragged to set the rail order, with + New. */
function EnvironmentBots({
  environmentId,
  title,
}: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const botsQuery = useEnvironmentQuery(botsEnvironment.list({ environmentId, input: {} }));
  const canAdd = useAtomValue(botsEnvironment.create.permissionAtom(environmentId));
  const canReorder = useAtomValue(botsEnvironment.reorder.permissionAtom(environmentId));
  const reorder = useAtomCommand(botsEnvironment.reorder);
  const projectsByBot = groupProjectsByBot(
    useProjects().filter((project) => project.environmentId === environmentId),
  );
  const selectedBotId = useSearch({
    strict: false,
    select: (search) =>
      search.environmentId === environmentId && typeof search.botId === "string"
        ? search.botId
        : null,
  });
  // The dropped order shows until the server sends the next list.
  const [pending, setPending] = useState<{
    readonly order: ReadonlyArray<string>;
    readonly basis: ReadonlyArray<Bot>;
  } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));
  const loaded = botsQuery.data ?? [];
  const pendingOrder = pending !== null && pending.basis === loaded ? pending.order : null;
  const bots = pendingOrder
    ? pendingOrder.flatMap((id) => loaded.filter((bot) => bot.id === id))
    : loaded;
  const closeSheet = () => {
    if (isMobile) setOpenMobile(false);
  };

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const next = moveBotTo(
      bots.map((bot) => bot.id),
      String(active.id),
      String(over.id),
    );
    if (!next) return;
    setPending({ order: next, basis: loaded });
    const result = await reorder({ environmentId, input: { botIds: next } });
    if (result._tag === "Success") return;
    setPending(null);
    toastManager.add({
      type: "error",
      title: "Could not reorder bots",
      description: formatEnvironmentQueryError(result.cause),
    });
  };

  return (
    <section aria-label={title}>
      <div className="flex items-center gap-1 pb-1 ps-2">
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {title}
        </h3>
        <Button
          size="xs"
          variant="ghost-muted"
          aria-label={`New bot on ${title}`}
          disabled={!canAdd}
          onClick={() => {
            closeSheet();
            void navigate({ to: BOTS_PATH, search: { environmentId, new: true } });
          }}
        >
          <PlusIcon />
          New
        </Button>
      </div>
      {botsQuery.error ? (
        <p className="px-2 text-xs text-destructive" role="status">
          Could not load bots: {botsQuery.error}
        </p>
      ) : !botsQuery.data ? (
        <p className="px-2 text-xs text-muted-foreground" role="status">
          Loading bots…
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={DND_MODIFIERS}
          onDragEnd={(event) => void onDragEnd(event)}
        >
          <SortableContext
            items={bots.map((bot) => bot.id)}
            strategy={verticalListSortingStrategy}
            disabled={!canReorder || pendingOrder !== null}
          >
            <ul className="flex flex-col gap-0.5">
              {bots.map((bot) => (
                <BotRow
                  key={bot.id}
                  environmentId={environmentId}
                  bot={bot}
                  projectCount={projectsByBot.get(bot.id)?.length ?? 0}
                  selected={bot.id === selectedBotId}
                  onOpen={closeSheet}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}

/** One bot: its avatar and name, then how many projects it owns and its model. */
function BotRow({
  environmentId,
  bot,
  projectCount,
  selected,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly projectCount: number;
  readonly selected: boolean;
  readonly onOpen: () => void;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: bot.id,
  });
  const detail = [
    `${projectCount} ${projectCount === 1 ? "project" : "projects"}`,
    bot.modelSelection?.model ?? "No model yet",
  ].join(" · ");
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "relative z-10")}
    >
      <Link
        to={BOTS_PATH}
        search={{ environmentId, botId: bot.id }}
        aria-current={selected ? "page" : undefined}
        onClick={onOpen}
        className={cn(
          "flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected && "bg-sidebar-row-selected",
          isDragging && "bg-sidebar-row-hover",
        )}
        {...listeners}
      >
        <BotAvatar avatar={bot.avatar} color={bot.color} size={26} shaded={false} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-sidebar-foreground">{bot.name}</span>
          <span className="truncate text-xs text-muted-foreground">{detail}</span>
        </span>
      </Link>
    </li>
  );
}
