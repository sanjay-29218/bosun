import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  featureCardKey,
  featureRef,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";

import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import type { FeatureBoardHandlers } from "./FeatureBoards";
import { WithThreadDetails, featureStatus } from "./FeatureCard";
import { FeatureNow } from "./FeatureNow";

/** A parent's child features, each opening its own lead, under the parent's card. */
export function FeatureChildList(props: {
  readonly cards: ReadonlyArray<EnvironmentFeatureCard>;
  readonly handlers: Pick<FeatureBoardHandlers, "threadsFor" | "onOpen" | "onMenu" | "projectFor">;
}) {
  if (props.cards.length === 0) return null;
  return (
    <ul className="relative z-10 mt-2 flex flex-col gap-0.5 border-t border-border/60 pt-1.5">
      {props.cards.map((child) => (
        <FeatureChildLine key={featureCardKey(child)} card={child} handlers={props.handlers} />
      ))}
    </ul>
  );
}

/** One child feature: its status and name, with its lead's details on hover. */
function FeatureChildLine(props: {
  readonly card: EnvironmentFeatureCard;
  readonly handlers: Pick<FeatureBoardHandlers, "threadsFor" | "onOpen" | "onMenu" | "projectFor">;
}) {
  const { card, handlers } = props;
  const lead = useThreadShell(
    card.leadThreadId ? scopeThreadRef(card.environmentId, card.leadThreadId) : null,
  );
  const { status } = featureStatus(card, handlers.threadsFor(card));
  const StatusIcon = status.icon;
  const ref = featureRef(card);
  return (
    <li>
      <WithThreadDetails
        shell={lead}
        project={handlers.projectFor(card)}
        status={<FeatureNow card={card} threadsFor={handlers.threadsFor} />}
      >
        <button
          type="button"
          onClick={() => handlers.onOpen(card)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handlers.onMenu(card, event);
          }}
          className="flex w-full min-w-0 cursor-default items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-secondary-label outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <StatusIcon
            aria-label={status.label}
            className={cn("size-3.5 shrink-0", status.className)}
          />
          {ref ? <span className="shrink-0 tabular-nums">{ref}</span> : null}
          <span className="min-w-0 truncate">{card.title}</span>
        </button>
      </WithThreadDetails>
    </li>
  );
}
