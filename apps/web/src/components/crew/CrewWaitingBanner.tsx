import { formatStageName } from "@t3tools/client-runtime/crew-stage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { FlagIcon, HandIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";
import { ComposerBanner } from "../chat/ComposerBanner";
import { Button } from "../ui/button";
import { useCrewStageContext } from "./useCrewStage";

/**
 * In a feature's other threads, such as its lead's: what the active stage waits on you for,
 * with a way to it. A gate approves from here; anything else needs the stage's own banner.
 */
export function CrewWaitingBanner() {
  const stage = useCrewStageContext();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const waiting = stage?.waiting;
  if (!stage || !waiting) return null;
  const { prompt } = waiting;
  const stageName = formatStageName(prompt.stepId);
  const title =
    prompt.kind === "gate"
      ? `${stageName} waits for your approval`
      : prompt.kind === "failure"
        ? `${stageName} failed`
        : prompt.kind === "your-call"
          ? `${stageName} reached its limit; it's your call`
          : `You're driving ${stageName}`;
  const open = () =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(stage.thread.environmentId, waiting.threadId)),
    });
  const approve = async () => {
    setBusy(true);
    await stage.run("approve");
    setBusy(false);
  };
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        data-chat-composer-crew-stage="true"
        variant={prompt.kind === "failure" ? "error" : "warning"}
        density="spacious"
      >
        <ComposerBanner.Row layout="approval">
          <ComposerBanner.Icon>
            {prompt.kind === "failure" ? (
              <TriangleAlertIcon />
            ) : prompt.kind === "taken-over" ? (
              <HandIcon />
            ) : (
              <FlagIcon />
            )}
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <Button size="xs" variant="outline" onClick={open}>
              Open {stageName}
            </Button>
            {prompt.kind === "gate" && stage.actions.includes("approve") ? (
              <Button size="xs" disabled={busy} onClick={() => void approve()}>
                Approve
              </Button>
            ) : null}
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
