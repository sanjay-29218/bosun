import {
  formatStageName,
  sendBackTargets,
  type CrewAction,
} from "@t3tools/client-runtime/crew-stage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ModelSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { EllipsisIcon, FlagIcon, HandIcon, RepeatIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { getComposerDraftState, useComposerDraftStore } from "../../composerDraftStore";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useServerConfigs } from "../../state/entities";
import { ComposerBanner, type ComposerBannerVariant } from "../chat/ComposerBanner";
import { composerFloatingLayerProps } from "../chat/composerEventScope";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { CREW_ACTION_COPY } from "./crewActionCopy";
import { useCrewStageContext, type CrewStage } from "./useCrewStage";

/**
 * The stage banner in a stage thread's composer: a gate, a failure, a loop limit, or a stage
 * you took over. It sits where tool approvals do, and notes come from the composer text.
 */
export function CrewStageBanner() {
  const stage = useCrewStageContext();
  const [busy, setBusy] = useState(false);
  if (!stage?.prompt || !stage.snapshot) return null;
  const { prompt, snapshot, thread, actions } = stage;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const readNote = () =>
    getComposerDraftState(useComposerDraftStore.getState(), threadRef)?.prompt.trim() ?? "";
  const act = async (action: CrewAction, input: Parameters<CrewStage["run"]>[1] = {}) => {
    setBusy(true);
    try {
      const ok = await stage.run(action, input);
      // A note that reached the stage is spent.
      if (ok && input.text) useComposerDraftStore.getState().setPrompt(threadRef, "");
    } finally {
      setBusy(false);
    }
  };
  const withNote = (action: CrewAction, extra: Parameters<CrewStage["run"]>[1] = {}) =>
    void act(action, { ...extra, text: readNote() });
  const has = (action: CrewAction) => actions.includes(action);
  const task = snapshot.definition.steps[prompt.stepId];
  const bot = task?.type === "task" ? formatStageName(task.bot) : null;
  const stageName = formatStageName(prompt.stepId);

  let variant: ComposerBannerVariant = "warning";
  let icon: ReactNode = <FlagIcon />;
  let title: string;
  let detail: string | null = null;
  let primary: ReactNode = null;
  switch (prompt.kind) {
    case "gate":
      title = `${stageName} approval`;
      detail = prompt.summary;
      primary = (
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            title="Uses the composer text as the change request"
            onClick={() => {
              if (readNote()) withNote("request-changes");
              else
                toastManager.add({
                  type: "info",
                  title: "Describe the changes you want in the composer first",
                });
            }}
          >
            Request changes
          </Button>
          <Button size="xs" disabled={busy} onClick={() => void act("approve")}>
            Approve
          </Button>
        </>
      );
      break;
    case "failure":
      variant = "error";
      icon = <TriangleAlertIcon />;
      title = `${stageName} failed · attempt ${prompt.attempt}`;
      detail = prompt.error;
      primary = (
        <>
          {has("send-back") ? <SendBackMenu stage={stage} busy={busy} onPick={withNote} /> : null}
          <Button size="xs" disabled={busy} onClick={() => void act("retry")}>
            Retry
          </Button>
        </>
      );
      break;
    case "your-call":
      title = `${stageName} reached its ${prompt.reason === "loop-limit" ? "loop" : "stage"} limit`;
      detail = `Next would be ${formatStageName(prompt.target)}. It's your call.`;
      primary = (
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void act("one-more-round")}
          >
            One more round
          </Button>
          <Button size="xs" disabled={busy} onClick={() => void act("accept-as-is")}>
            Accept as is
          </Button>
        </>
      );
      break;
    case "taken-over":
      variant = "default";
      icon = <HandIcon />;
      title = `You're driving ${stageName}`;
      detail =
        "Mark it done to hand your result to the next stage. The composer text is the summary.";
      primary =
        prompt.outcomes.length > 1 ? (
          <Menu>
            <MenuTrigger disabled={busy} render={<Button size="xs" />}>
              Mark stage done
            </MenuTrigger>
            <MenuPopup {...composerFloatingLayerProps} side="top" align="end">
              <MenuGroup>
                <MenuGroupLabel>Outcome</MenuGroupLabel>
                {prompt.outcomes.map((outcome) => (
                  <MenuItem key={outcome} onClick={() => withNote("mark-done", { outcome })}>
                    {formatStageName(outcome)}
                  </MenuItem>
                ))}
              </MenuGroup>
            </MenuPopup>
          </Menu>
        ) : (
          <Button
            size="xs"
            disabled={busy}
            onClick={() => withNote("mark-done", { outcome: prompt.outcomes[0] ?? "" })}
          >
            Mark stage done
          </Button>
        );
      break;
  }

  const overflow: Array<CrewAction> = (
    {
      gate: ["take-over", "send-back", "cancel"],
      failure: ["take-over", "skip", "cancel"],
      "your-call": ["take-over", "send-back", "cancel"],
      "taken-over": ["retry", "send-back", "cancel"],
    } satisfies Record<typeof prompt.kind, Array<CrewAction>>
  )[prompt.kind].filter(has);

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        data-chat-composer-crew-stage="true"
        variant={variant}
        density="spacious"
      >
        <ComposerBanner.Row layout="approval">
          <ComposerBanner.Icon
            className={
              variant === "error"
                ? "group-data-[composer-banner-layout=approval]/banner-row:text-destructive"
                : variant === "default"
                  ? "group-data-[composer-banner-layout=approval]/banner-row:text-muted-foreground"
                  : undefined
            }
          >
            {icon}
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="flex min-w-0 flex-col gap-0.5 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium text-foreground">{title}</span>
                {bot ? <span className="text-muted-foreground"> · {bot}</span> : null}
              </span>
              {detail ? (
                <span className="line-clamp-2 text-xs text-muted-foreground">{detail}</span>
              ) : null}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {primary}
            <Menu>
              <MenuTrigger
                disabled={busy}
                render={<Button size="icon-xs" variant="outline" aria-label="More stage actions" />}
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup {...composerFloatingLayerProps} side="top" align="end">
                {prompt.kind === "gate" ? (
                  <ActionItem
                    label="Approve with a note"
                    description="The composer text travels to the next stage"
                    onClick={() => withNote("approve")}
                  />
                ) : null}
                {prompt.kind === "failure" ? (
                  <RetryWithModel stage={stage} onPick={withNote} />
                ) : null}
                {overflow.map((action) =>
                  action === "send-back" ? (
                    <SendBackSubmenu key={action} stage={stage} onPick={withNote} />
                  ) : (
                    <ActionItem
                      key={action}
                      {...CREW_ACTION_COPY[action]}
                      onClick={() => void act(action)}
                    />
                  ),
                )}
              </MenuPopup>
            </Menu>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

function ActionItem(props: {
  readonly label: string;
  readonly description: string;
  readonly onClick: () => void;
}) {
  return (
    <MenuItem onClick={props.onClick}>
      <span className="flex min-w-0 flex-col">
        <span>{props.label}</span>
        <span className="text-xs text-muted-foreground">{props.description}</span>
      </span>
    </MenuItem>
  );
}

type PickHandler = (action: CrewAction, input?: Parameters<CrewStage["run"]>[1]) => void;

function SendBackMenu(props: { stage: CrewStage; busy: boolean; onPick: PickHandler }) {
  const targets = props.stage.snapshot ? sendBackTargets(props.stage.snapshot) : [];
  return (
    <Menu>
      <MenuTrigger disabled={props.busy} render={<Button size="xs" variant="outline" />}>
        Send back…
      </MenuTrigger>
      <MenuPopup {...composerFloatingLayerProps} side="top" align="end">
        {targets.map((stepId) => (
          <MenuItem key={stepId} onClick={() => props.onPick("send-back", { stepId })}>
            {formatStageName(stepId)}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function SendBackSubmenu(props: { stage: CrewStage; onPick: PickHandler }) {
  const targets = props.stage.snapshot ? sendBackTargets(props.stage.snapshot) : [];
  return (
    <MenuSub>
      <MenuSubTrigger>{CREW_ACTION_COPY["send-back"].label}</MenuSubTrigger>
      <MenuSubPopup {...composerFloatingLayerProps}>
        {targets.map((stepId) => (
          <MenuItem key={stepId} onClick={() => props.onPick("send-back", { stepId })}>
            {formatStageName(stepId)}
          </MenuItem>
        ))}
      </MenuSubPopup>
    </MenuSub>
  );
}

/** Same handoff, another provider or model: every available instance's models. */
function RetryWithModel(props: { stage: CrewStage; onPick: PickHandler }) {
  const providers = useServerConfigs().get(props.stage.thread.environmentId)?.providers;
  const entries = useMemo(
    () =>
      deriveProviderInstanceEntries(providers ?? []).filter(
        (entry) => entry.enabled && entry.isAvailable && entry.models.length > 0,
      ),
    [providers],
  );
  if (entries.length === 0) return null;
  const pick = (selection: ModelSelection) => props.onPick("retry", { modelSelection: selection });
  return (
    <MenuSub>
      <MenuSubTrigger>
        <RepeatIcon className="size-3.5" />
        Retry with another model
      </MenuSubTrigger>
      <MenuSubPopup {...composerFloatingLayerProps}>
        {entries.map((entry) => (
          <MenuGroup key={entry.instanceId}>
            <MenuGroupLabel>{entry.displayName}</MenuGroupLabel>
            {entry.models.map((model) => (
              <MenuItem
                key={model.slug}
                onClick={() => pick(createModelSelection(entry.instanceId, model.slug))}
              >
                {model.name}
              </MenuItem>
            ))}
          </MenuGroup>
        ))}
      </MenuSubPopup>
    </MenuSub>
  );
}
