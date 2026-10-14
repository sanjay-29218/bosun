import { LegendList } from "@legendapp/list/react";
import {
  FEATURE_PHASE_LABELS,
  NEEDS_YOU_LABELS,
  featureCardKey,
  stageLabel,
  type EnvironmentFeatureCard,
  type FeaturePhaseGroup,
  type NeedsYouGroup,
  type NeedsYouItem,
} from "@t3tools/client-runtime/state/crew-board";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ProjectFavicon } from "../ProjectFavicon";
import { FeatureCard, waitingLabel } from "./FeatureCard";
import type { FeatureBoardHandlers } from "./FeatureBoards";
import type { useFeatureActions } from "./useFeatureActions";

type ListEntry =
  | {
      readonly type: "header";
      readonly key: string;
      readonly label: string;
      readonly count: number;
    }
  | { readonly type: "card"; readonly key: string; readonly card: EnvironmentFeatureCard };

/** The list view: every phase as a heading over its rows, virtualized for long boards. */
export function FeatureListView(props: {
  readonly groups: ReadonlyArray<FeaturePhaseGroup>;
  readonly handlers: FeatureBoardHandlers;
}) {
  const data: ListEntry[] = [];
  for (const group of props.groups) {
    if (group.cards.length === 0) continue;
    data.push({
      type: "header",
      key: `phase:${group.phase}`,
      label: FEATURE_PHASE_LABELS[group.phase],
      count: group.cards.length,
    });
    for (const card of group.cards) data.push({ type: "card", key: featureCardKey(card), card });
  }
  return (
    <LegendList<ListEntry>
      data={data}
      keyExtractor={(entry) => entry.key}
      getItemType={(entry) => entry.type}
      estimatedItemSize={44}
      drawDistance={600}
      recycleItems={false}
      className="min-h-0 flex-1"
      renderItem={({ item }) =>
        item.type === "header" ? (
          <h2 className="flex items-center gap-1.5 px-1 pt-4 pb-1.5 text-sm font-medium">
            {item.label}
            <span className="text-muted-foreground tabular-nums">{item.count}</span>
          </h2>
        ) : (
          <div className="pb-1">
            <FeatureCard
              card={item.card}
              project={props.handlers.projectFor(item.card)}
              queuePosition={props.handlers.queuePositions.get(item.key)}
              layout="row"
              draggable={false}
              onOpen={props.handlers.onOpen}
              onMenu={props.handlers.onMenu}
            />
          </div>
        )
      }
    />
  );
}

/** One line on what the item waits for: the gate, the failure, the question. */
function needsYouSummary(item: NeedsYouItem): string {
  if (item.type === "thread")
    return item.kind === "approval" ? "Waiting on a tool approval" : "Asked you a question";
  const { card } = item;
  const stage = card.stage ? stageLabel(card.stage.stepId) : "Stage";
  switch (card.state) {
    case "approval":
      return `${stage} approval${card.detail ? ` · ${card.detail}` : ""}`;
    case "failed":
      return `${stage} failed${card.detail ? ` · ${card.detail}` : ""}${card.stage && card.stage.attempt > 1 ? ` · attempt ${card.stage.attempt}` : ""}`;
    case "your-call":
      return card.yourCall
        ? `Your call · ${stageLabel(card.yourCall.stepId)} reached its limit for “${card.yourCall.outcome.replace(/_/g, " ")}”`
        : "Your call";
    case "input":
      return card.detail
        ? `${stageLabel(card.stage?.role ?? "crew")} asks: “${card.detail}”`
        : "A question is waiting";
    default:
      return stage;
  }
}

function AnswerField(props: { readonly onAnswer: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      if (await props.onAnswer(value)) setText("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        size="sm"
        aria-label="Answer"
        placeholder="Answer…"
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="w-56"
      />
      <Button size="sm" type="submit" disabled={busy || !text.trim()}>
        Answer
      </Button>
    </form>
  );
}

/**
 * Everything waiting on you, grouped and oldest first. Approvals, retries and answers can be
 * done from the row; everything else opens the stage thread.
 */
export function NeedsYouListView(props: {
  readonly groups: ReadonlyArray<NeedsYouGroup>;
  readonly projectFor: (item: {
    readonly environmentId: EnvironmentFeatureCard["environmentId"];
    readonly projectId: EnvironmentFeatureCard["projectId"];
  }) => EnvironmentProject | null;
  readonly actions: ReturnType<typeof useFeatureActions>;
  readonly onOpenThread: (item: NeedsYouItem) => void;
}) {
  if (props.groups.length === 0)
    return <p className="py-10 text-center text-sm text-muted-foreground">Nothing needs you</p>;
  return (
    <div className="flex flex-col gap-5">
      {props.groups.map((group) => (
        <section key={group.kind} className="flex flex-col gap-1.5">
          <h2 className="flex items-center gap-1.5 px-1 text-sm font-medium">
            {NEEDS_YOU_LABELS[group.kind]}
            <span className="text-muted-foreground tabular-nums">{group.items.length}</span>
          </h2>
          {group.items.map((item) => {
            const source = item.type === "feature" ? item.card : item.shell;
            const project = props.projectFor(source);
            const title = item.type === "feature" ? item.card.title : item.shell.title;
            const waiting = waitingLabel(item.since);
            return (
              <div
                key={item.key}
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs [contain-intrinsic-size:auto_52px] [content-visibility:auto]"
              >
                <span className="flex w-36 min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground">
                  {project ? (
                    <ProjectFavicon project={project} className="size-3.5 shrink-0" />
                  ) : null}
                  <span className="truncate">{project?.title ?? "Project"}</span>
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{title}</span>
                  <span className="truncate text-muted-foreground">{needsYouSummary(item)}</span>
                </span>
                {waiting ? (
                  <span className="shrink-0 text-muted-foreground">waiting {waiting}</span>
                ) : null}
                <span className="flex shrink-0 items-center gap-1.5">
                  {item.type === "feature" && item.card.state === "input" ? (
                    <AnswerField
                      onAnswer={(text) => props.actions.run(item.card, "answer", { text })}
                    />
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => props.onOpenThread(item)}>
                      Open
                    </Button>
                  )}
                  {item.type === "feature" && item.card.state === "approval" ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void props.actions.run(item.card, "request-changes")}
                      >
                        Request changes
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void props.actions.run(item.card, "approve")}
                      >
                        Approve
                      </Button>
                    </>
                  ) : null}
                  {item.type === "feature" && item.card.state === "failed" ? (
                    <Button size="sm" onClick={() => void props.actions.run(item.card, "retry")}>
                      Retry
                    </Button>
                  ) : null}
                </span>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
