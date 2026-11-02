import type { MenuAction } from "@react-native-menu/menu";
import {
  crewCurrentThreadId,
  humanizeCrewId,
  workflowStageIds,
} from "@t3tools/client-runtime/state/crew";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Alert } from "react-native";

import { Menu } from "../../components/ui/Menu";
import { uuidv4 } from "../../lib/uuid";
import { featuresEnvironment, type CrewThreadStage } from "../../state/features";
import { useAtomCommand } from "../../state/use-atom-command";
import { ApprovalCardLayout } from "../threads/PendingApprovalCard";
import { RequestActionButton } from "./RequestActionButton";

type CardKind = "paused" | "queued" | "cancelled" | "done";

function cardKind(stage: CrewThreadStage): CardKind | null {
  switch (stage.summary.state) {
    case "paused":
    case "queued":
    case "cancelled":
      return stage.summary.current ? stage.summary.state : null;
    case "done":
      // Done features have no current stage; the last stage thread offers the follow-up.
      return crewCurrentThreadId(stage.snapshot) === stage.threadId ? "done" : null;
    default:
      return null;
  }
}

const REOPEN_AT = "reopen:";

/**
 * The card above the composer of a stage thread whose feature is paused, queued or closed, with
 * its way out. A stage that waits for a decision asks in the thread's question card instead.
 */
export function CrewStageCard(props: {
  readonly environmentId: EnvironmentId;
  readonly stage: CrewThreadStage;
  readonly canOperate: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const startNow = useAtomCommand(featuresEnvironment.startNow);
  const resume = useAtomCommand(featuresEnvironment.resume);
  const cancel = useAtomCommand(featuresEnvironment.cancel);
  const reopen = useAtomCommand(featuresEnvironment.reopen);

  const snapshot = props.stage.snapshot;
  const kind = cardKind(props.stage);
  if (kind === null) return null;

  const base = { projectId: snapshot.projectId, featureId: snapshot.featureId };
  const target = <I,>(input: I) => ({ environmentId: props.environmentId, input });
  const action = (name: string) => ({ ...base, requestId: `crew-${name}:${uuidv4()}` });
  const disabled = busy || !props.canOperate;

  const run = async (send: () => Promise<{ readonly _tag: string }>) => {
    if (busy) return;
    setBusy(true);
    await send();
    setBusy(false);
  };

  const stopItem: MenuAction = {
    id: "cancel",
    title: "Stop feature",
    attributes: { destructive: true },
  };
  const confirmStop = () =>
    Alert.alert("Stop feature?", "Running stages stop. You can reopen it later.", [
      { text: "Keep running", style: "cancel" },
      {
        text: "Stop feature",
        style: "destructive",
        onPress: () => void run(() => cancel(target(action("cancel")))),
      },
    ]);
  const moreButton = (
    <Menu
      accessibilityLabel="More actions"
      actions={[stopItem]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "cancel") confirmStop();
      }}
    >
      <RequestActionButton label="More actions" tone="secondary" disabled={disabled} />
    </Menu>
  );

  switch (kind) {
    case "paused":
      return (
        <ApprovalCardLayout kicker="Paused" title={snapshot.definition.name}>
          <RequestActionButton
            label="Resume"
            disabled={disabled}
            onPress={() => void run(() => resume(target(action("resume"))))}
          />
          {moreButton}
        </ApprovalCardLayout>
      );
    case "queued":
      return (
        <ApprovalCardLayout
          kicker="Queued"
          title={humanizeCrewId(snapshot.stage?.stepId ?? props.stage.summary.stepId)}
          detail="Waiting for a free stage slot."
        >
          <RequestActionButton
            label="Start now"
            disabled={disabled}
            onPress={() => void run(() => startNow(target(base)))}
          />
          {moreButton}
        </ApprovalCardLayout>
      );
    case "cancelled":
      return (
        <ApprovalCardLayout kicker="Stopped" title={props.stage.title}>
          <RequestActionButton
            label="Reopen"
            disabled={disabled}
            onPress={() => void run(() => reopen(target(action("reopen"))))}
          />
        </ApprovalCardLayout>
      );
    case "done":
      return (
        <ApprovalCardLayout
          kicker="Done"
          title={props.stage.title}
          detail="Reopen to start a follow-up at a stage."
        >
          <Menu
            accessibilityLabel="Reopen at a stage"
            actions={workflowStageIds(snapshot.definition).map((id) => ({
              id: `${REOPEN_AT}${id}`,
              title: humanizeCrewId(id),
            }))}
            onPressAction={({ nativeEvent }) => {
              const stepId = nativeEvent.event.slice(REOPEN_AT.length);
              void run(() => reopen(target({ ...action("reopen"), stepId })));
            }}
          >
            <RequestActionButton label="Reopen at…" tone="secondary" disabled={disabled} />
          </Menu>
        </ApprovalCardLayout>
      );
  }
}
