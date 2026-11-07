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
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { botsEnvironment } from "../../state/bots";
import { useShownBotEnvironmentIds } from "../../state/botRail";
import { useProjects } from "../../state/entities";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { SettingsSection } from "../settings/settingsLayout";
import { BOTS_SETTINGS_PATH } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { groupProjectsByBot, moveBotTo } from "./bots.logic";

/**
 * Settings → Bots' list: each shown environment's bots in rail order, dragged to reorder.
 * `onNew` adds one on an environment.
 */
export function BotList({ onNew }: { readonly onNew: (environmentId: EnvironmentId) => void }) {
  const environmentIds = useShownBotEnvironmentIds();
  const identities = useEnvironmentIdentities();
  const connected = useConnectedEnvironmentIds();
  const labelById = new Map(identities.map((identity) => [identity.environmentId, identity.label]));

  if (environmentIds.length === 0) {
    return (
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        {connected.length === 0
          ? "No environments connected"
          : "No connected environment runs bots"}
      </p>
    );
  }
  return environmentIds.map((environmentId) => (
    <EnvironmentBots
      key={environmentId}
      environmentId={environmentId}
      title={labelById.get(environmentId) ?? "Environment"}
      showTitle={environmentIds.length > 1}
      onNew={() => onNew(environmentId)}
    />
  ));
}

// Pointer only: rows are links, so Enter opens a bot. The bot's menu moves it by keyboard.
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } };
const DND_MODIFIERS = [restrictToVerticalAxis];

/** One environment's bots, dragged to set the rail order. */
function EnvironmentBots({
  environmentId,
  title,
  showTitle,
  onNew,
}: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly showTitle: boolean;
  readonly onNew: () => void;
}) {
  const botsQuery = useEnvironmentQuery(botsEnvironment.list({ environmentId, input: {} }));
  const canAdd = useAtomValue(botsEnvironment.create.permissionAtom(environmentId));
  const canReorder = useAtomValue(botsEnvironment.reorder.permissionAtom(environmentId));
  const reorder = useAtomCommand(botsEnvironment.reorder);
  const projectsByBot = groupProjectsByBot(
    useProjects().filter((project) => project.environmentId === environmentId),
  );
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
    <SettingsSection
      title={title}
      hideTitle={!showTitle}
      headerAction={
        showTitle ? (
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label={`Add a bot on ${title}`}
            disabled={!canAdd}
            onClick={onNew}
          >
            <PlusIcon />
            Add
          </Button>
        ) : null
      }
    >
      {botsQuery.error ? (
        <p className="px-4 py-3 text-sm text-destructive" role="status">
          Could not load bots: {botsQuery.error}
        </p>
      ) : !botsQuery.data ? (
        <p className="px-4 py-3 text-sm text-muted-foreground" role="status">
          Loading bots…
        </p>
      ) : bots.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No bots yet. A bot runs your projects and talks to you in its own thread.
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
            <ul className="divide-y divide-border/50">
              {bots.map((bot) => (
                <BotRow
                  key={bot.id}
                  environmentId={environmentId}
                  bot={bot}
                  projectCount={projectsByBot.get(bot.id)?.length ?? 0}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </SettingsSection>
  );
}

/** One bot: its avatar and name, then how many projects it owns and its model. */
function BotRow({
  environmentId,
  bot,
  projectCount,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly projectCount: number;
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
      className={cn(isDragging && "relative z-10 bg-card")}
    >
      <Link
        to={BOTS_SETTINGS_PATH}
        search={{ environmentId, botId: bot.id }}
        className="flex min-w-0 items-center gap-3 px-4 py-2.5 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        {...listeners}
      >
        <BotAvatar avatar={bot.avatar} color={bot.color} size={32} shaded={false} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{bot.name}</span>
          <span className="truncate text-xs text-muted-foreground">{detail}</span>
        </span>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}
