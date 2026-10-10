import {
  DONE_COLUMN_ID,
  FEATURE_PHASE_LABELS,
  featureCardKey,
  featureDropAction,
  stageLabel,
  type EnvironmentFeatureCard,
  type FeaturePhaseGroup,
  type FeatureStageBoard,
} from "@t3tools/client-runtime/state/crew-board";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ChevronRightIcon } from "lucide-react";
import { useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { FeatureCard } from "./FeatureCard";

/** Done keeps its newest few visible, like the Settled shelf. */
const DONE_PAGE = 10;

export interface FeatureBoardHandlers {
  readonly projectFor: (card: EnvironmentFeatureCard) => EnvironmentProject | null;
  readonly queuePositions: ReadonlyMap<string, number>;
  readonly onOpen: (card: EnvironmentFeatureCard) => void;
  readonly onMenu: (card: EnvironmentFeatureCard, event: MouseEvent) => void;
  /** Called only for an allowed move: into Done cancels, out of it reopens. */
  readonly onDrop: (
    card: EnvironmentFeatureCard,
    action: "cancel" | "reopen",
    position: { readonly x: number; readonly y: number },
  ) => void;
}

/** Drag state shared by a board's columns. Nothing moves until the server answers. */
function useCardDrag(handlers: FeatureBoardHandlers) {
  const dragged = useRef<EnvironmentFeatureCard | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const onDragStart = (card: EnvironmentFeatureCard, event: DragEvent) => {
    dragged.current = card;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.title);
  };
  const dropProps = (columnId: string, target: "done" | "open") => ({
    onDragOver: (event: DragEvent) => {
      const card = dragged.current;
      if (!card || featureDropAction(card, target) === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (over !== columnId) setOver(columnId);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setOver(null);
      const card = dragged.current;
      dragged.current = null;
      const action = card ? featureDropAction(card, target) : null;
      if (card && action) handlers.onDrop(card, action, { x: event.clientX, y: event.clientY });
    },
  });
  return {
    onDragStart,
    onDragEnd: () => {
      dragged.current = null;
      setOver(null);
    },
    over,
    dropProps,
  };
}

function Column(props: {
  readonly title: ReactNode;
  readonly count: number;
  readonly subtitle?: ReactNode;
  readonly highlighted: boolean;
  readonly children: ReactNode;
  readonly dropProps: ReturnType<ReturnType<typeof useCardDrag>["dropProps"]>;
}) {
  return (
    <section
      {...props.dropProps}
      className={cn(
        "flex w-64 shrink-0 flex-col gap-2 rounded-xl border border-transparent p-1",
        props.highlighted && "border-dashed border-border bg-accent/30",
      )}
    >
      <header className="flex min-w-0 flex-col px-1.5 pt-1">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {props.title}
          <span className="text-muted-foreground tabular-nums">{props.count}</span>
        </span>
        {props.subtitle ? (
          <span className="truncate text-xs text-muted-foreground">{props.subtitle}</span>
        ) : null}
      </header>
      {props.children}
    </section>
  );
}

function CardStack(props: {
  readonly cards: ReadonlyArray<EnvironmentFeatureCard>;
  readonly pageDone: boolean;
  readonly handlers: FeatureBoardHandlers;
  readonly onDragStart: (card: EnvironmentFeatureCard, event: DragEvent) => void;
  readonly onDragEnd: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = props.pageDone && !expanded ? props.cards.slice(0, DONE_PAGE) : props.cards;
  const hiddenCount = props.cards.length - visible.length;
  return (
    <div className="flex flex-col gap-1.5" onDragEnd={props.onDragEnd}>
      {visible.map((card) => (
        <FeatureCard
          key={featureCardKey(card)}
          card={card}
          project={props.handlers.projectFor(card)}
          queuePosition={props.handlers.queuePositions.get(featureCardKey(card))}
          layout="card"
          draggable
          onOpen={props.handlers.onOpen}
          onMenu={props.handlers.onMenu}
          onDragStart={props.onDragStart}
        />
      ))}
      {hiddenCount > 0 ? (
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
          Show {hiddenCount} more
        </Button>
      ) : null}
    </div>
  );
}

/** Phase columns across every workflow. */
export function FeaturePhaseBoard(props: {
  readonly groups: ReadonlyArray<FeaturePhaseGroup>;
  readonly handlers: FeatureBoardHandlers;
}) {
  const drag = useCardDrag(props.handlers);
  return (
    <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto pb-4">
      {props.groups.map((group) => {
        const target = group.phase === "done" ? "done" : "open";
        return (
          <Column
            key={group.phase}
            title={FEATURE_PHASE_LABELS[group.phase]}
            count={group.cards.length}
            highlighted={drag.over === group.phase}
            dropProps={drag.dropProps(group.phase, target)}
          >
            <CardStack
              cards={group.cards}
              pageDone={group.phase === "done"}
              handlers={props.handlers}
              onDragStart={drag.onDragStart}
              onDragEnd={drag.onDragEnd}
            />
          </Column>
        );
      })}
    </div>
  );
}

/**
 * One workflow's stages as columns: role headers, gates with their waiting counts, and loops
 * drawn as labelled arcs. Read-only; the graph is edited in Settings → Workflows.
 */
export function FeatureStageBoardView(props: {
  readonly board: FeatureStageBoard;
  readonly handlers: FeatureBoardHandlers;
  readonly gateFilter: string | null;
  readonly onGateFilter: (stepId: string | null) => void;
  readonly onOpenStage: (stepId: string) => void;
  readonly onShowPhases: () => void;
}) {
  const drag = useCardDrag(props.handlers);
  const { columns, loops, hidden } = props.board;
  const columnIndex = new Map(columns.map((column, index) => [column.stepId, index]));
  const hiddenCount = hidden.reduce((total, entry) => total + entry.count, 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="min-h-0 flex-1 overflow-x-auto pb-4">
        <div
          className="grid w-max gap-x-6 gap-y-1"
          style={{ gridTemplateColumns: `repeat(${columns.length}, 16rem)` }}
        >
          {loops.map((loop, loopIndex) => {
            const from = columnIndex.get(loop.from);
            const to = columnIndex.get(loop.to);
            if (from === undefined || to === undefined) return null;
            return (
              <div
                key={`${loop.from}:${loop.outcome}`}
                // A static arc: the box's top and sides, from the target back to the source.
                className="mx-16 flex h-5 items-start justify-center rounded-t-lg border-x border-t border-border text-2xs text-muted-foreground"
                style={{ gridColumn: `${to + 1} / ${from + 2}`, gridRow: loopIndex + 1 }}
              >
                <span className="-mt-2 bg-background px-1.5">
                  {loop.outcome.replace(/_/g, " ")} · back to {stageLabel(loop.to)}
                  {loop.limit !== null ? ` · max ${loop.limit}` : ""}
                </span>
              </div>
            );
          })}
          {columns.map((column, index) => {
            const isDone = column.stepId === DONE_COLUMN_ID;
            const cards =
              props.gateFilter === null
                ? column.cards
                : column.cards.filter(
                    (card) => column.stepId === props.gateFilter && card.state === "approval",
                  );
            return (
              <div key={column.stepId} className="relative" style={{ gridRow: loops.length + 1 }}>
                {index > 0 ? (
                  <ChevronRightIcon
                    aria-hidden
                    className="absolute top-2 -left-5 size-4 text-muted-foreground"
                  />
                ) : null}
                <Column
                  title={
                    isDone ? (
                      "Done"
                    ) : (
                      <button
                        type="button"
                        className="truncate hover:underline"
                        onClick={() => props.onOpenStage(column.stepId)}
                      >
                        {stageLabel(column.stepId)}
                      </button>
                    )
                  }
                  count={column.cards.length}
                  subtitle={
                    isDone ? (
                      "Merged or closed"
                    ) : (
                      <span className="flex items-center gap-1.5">
                        {column.role ? stageLabel(column.role) : null}
                        {column.onlyInRevision !== null ? (
                          <span className="rounded border border-border px-1 text-3xs">
                            v{column.onlyInRevision} only
                          </span>
                        ) : null}
                        {column.gate ? (
                          <button
                            type="button"
                            aria-pressed={props.gateFilter === column.stepId}
                            onClick={() =>
                              props.onGateFilter(
                                props.gateFilter === column.stepId ? null : column.stepId,
                              )
                            }
                            className={cn(
                              "ms-auto rounded-full border border-border px-1.5 text-2xs",
                              props.gateFilter === column.stepId && "bg-accent",
                            )}
                          >
                            Gate
                            {column.waiting > 0 ? (
                              <span className="ms-1 text-warning-foreground tabular-nums">
                                {column.waiting} waiting
                              </span>
                            ) : null}
                          </button>
                        ) : null}
                      </span>
                    )
                  }
                  highlighted={drag.over === column.stepId}
                  dropProps={drag.dropProps(column.stepId, isDone ? "done" : "open")}
                >
                  <CardStack
                    cards={cards}
                    pageDone={isDone}
                    handlers={props.handlers}
                    onDragStart={drag.onDragStart}
                    onDragEnd={drag.onDragEnd}
                  />
                </Column>
              </div>
            );
          })}
        </div>
      </div>
      {hiddenCount > 0 ? (
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {hiddenCount} {hiddenCount === 1 ? "feature" : "features"} on other workflows or projects{" "}
          {hiddenCount === 1 ? "is" : "are"} hidden (
          {hidden.map((entry) => `${entry.name} ${entry.count}`).join(", ")}).
          <Button variant="link" size="xs" onClick={props.onShowPhases}>
            Show phases
          </Button>
        </p>
      ) : null}
    </div>
  );
}
