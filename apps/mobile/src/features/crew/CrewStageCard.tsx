import type { MenuAction } from "@react-native-menu/menu";
import {
  crewCurrentStep,
  crewCurrentThreadId,
  crewFailureDetail,
  crewGateCopy,
  crewOpenQuestion,
  crewSendBackTargets,
  crewStageOutcomes,
  crewStageRole,
  humanizeCrewId,
  workflowStageIds,
} from "@t3tools/client-runtime/state/crew";
import type {
  EnvironmentId,
  ModelSelection,
  ServerProvider,
  WorkflowFeatureSnapshot,
} from "@t3tools/contracts";
import { useState } from "react";
import { Alert } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { uuidv4 } from "../../lib/uuid";
import { featuresEnvironment, type CrewThreadStage } from "../../state/features";
import { useAtomCommand } from "../../state/use-atom-command";
import { ApprovalCardLayout } from "../threads/PendingApprovalCard";
import { RequestActionButton } from "./RequestActionButton";

/** What the composer does while a Crew card is up: its text becomes the card's note. */
export interface CrewComposerMode {
  readonly placeholder: string;
  /** Set when sending a message would reach a crew member that isn't waiting for one. */
  readonly sendBlockedReason: string | null;
}

/** Composer behavior for the current stage thread, or null to leave the composer alone. */
export function crewComposerMode(stage: CrewThreadStage | null): CrewComposerMode | null {
  if (!stage?.summary.current) return null;
  const snapshot = stage.snapshot;
  const role = crewStageRole(snapshot.definition, stage.summary.stepId) ?? "crew";
  switch (stage.summary.state) {
    case "approval": {
      const recipient = crewGateCopy(snapshot)?.noteRecipient ?? role;
      return {
        placeholder: `Note for the ${recipient}…`,
        sendBlockedReason: "Approve or request changes above",
      };
    }
    case "failed":
      return {
        placeholder: `Tell the ${role} what to try…`,
        sendBlockedReason: "Retry or pick another action above",
      };
    case "your-call":
      return {
        placeholder: `Note for the ${role}…`,
        sendBlockedReason: "Decide above",
      };
    case "input":
      return crewOpenQuestion(snapshot) === null
        ? null
        : { placeholder: `Answer the ${role}…`, sendBlockedReason: "Answer above" };
    default:
      return null;
  }
}

type CardKind =
  | "question"
  | "gate"
  | "failure"
  | "your-call"
  | "taken-over"
  | "paused"
  | "queued"
  | "cancelled"
  | "done";

function cardKind(stage: CrewThreadStage, snapshot: WorkflowFeatureSnapshot): CardKind | null {
  if (crewCurrentStep(snapshot)?.status === "taken-over" && stage.summary.current) {
    return "taken-over";
  }
  switch (stage.summary.state) {
    case "approval":
      return stage.summary.current ? "gate" : null;
    case "failed":
      return stage.summary.current ? "failure" : null;
    case "your-call":
      return stage.summary.current ? "your-call" : null;
    case "input":
      return stage.summary.current && crewOpenQuestion(snapshot) !== null ? "question" : null;
    case "paused":
      return stage.summary.current ? "paused" : null;
    case "queued":
      return stage.summary.current ? "queued" : null;
    case "cancelled":
      return stage.summary.current ? "cancelled" : null;
    case "done":
      // Done features have no current stage; the last stage thread offers the follow-up.
      return crewCurrentThreadId(stage.snapshot) === stage.threadId ? "done" : null;
    default:
      return null;
  }
}

/** Ids for the More actions menu. Send back targets and models are encoded after a colon. */
const SEND_BACK = "send-back:";
const RETRY_MODEL = "retry-model:";
const MARK_DONE = "mark-done:";
const REOPEN_AT = "reopen:";

function modelMenu(providers: ReadonlyArray<ServerProvider>): MenuAction[] {
  return providers
    .filter((provider) => provider.enabled && provider.models.length > 0)
    .map((provider) => ({
      id: `provider:${provider.instanceId}`,
      title: provider.displayName ?? provider.instanceId,
      subactions: provider.models.map((model) => ({
        id: `${RETRY_MODEL}${JSON.stringify({ instanceId: provider.instanceId, model: model.slug })}`,
        title: model.name,
      })),
    }));
}

/**
 * The card above the composer of a stage thread that waits on the user: a gate, a failure,
 * Your call, or a stage the user took over. Paused, queued and closed features get a card
 * with their way out. The composer's text is sent as the note of whichever action is tapped.
 */
export function CrewStageCard(props: {
  readonly environmentId: EnvironmentId;
  readonly stage: CrewThreadStage;
  readonly canOperate: boolean;
  readonly note: string;
  readonly onNoteSent: () => void;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onViewDiff: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const approve = useAtomCommand(featuresEnvironment.approve);
  const requestChanges = useAtomCommand(featuresEnvironment.requestChanges);
  const retry = useAtomCommand(featuresEnvironment.retry);
  const takeOver = useAtomCommand(featuresEnvironment.takeOver);
  const markDone = useAtomCommand(featuresEnvironment.markDone);
  const sendBack = useAtomCommand(featuresEnvironment.sendBack);
  const skip = useAtomCommand(featuresEnvironment.skip);
  const acceptAsIs = useAtomCommand(featuresEnvironment.acceptAsIs);
  const oneMoreRound = useAtomCommand(featuresEnvironment.oneMoreRound);
  const startNow = useAtomCommand(featuresEnvironment.startNow);
  const resume = useAtomCommand(featuresEnvironment.resume);
  const cancel = useAtomCommand(featuresEnvironment.cancel);
  const reopen = useAtomCommand(featuresEnvironment.reopen);
  const answer = useAtomCommand(featuresEnvironment.answer);

  const snapshot = props.stage.snapshot;
  const kind = cardKind(props.stage, snapshot);
  if (kind === null) return null;

  const stepId = props.stage.summary.stepId;
  const stageName = humanizeCrewId(stepId);
  const role = crewStageRole(snapshot.definition, stepId) ?? "crew";
  const note = props.note.trim();
  const base = { projectId: snapshot.projectId, featureId: snapshot.featureId };
  const target = <I,>(input: I) => ({ environmentId: props.environmentId, input });
  const action = (name: string) => ({ ...base, requestId: `crew-${name}:${uuidv4()}` });
  const disabled = busy || !props.canOperate;

  const run = async (
    send: () => Promise<{ readonly _tag: string }>,
    options: { readonly sendsNote?: boolean } = {},
  ) => {
    if (busy) return;
    setBusy(true);
    setHint(null);
    const result = await send();
    if (result._tag === "Success" && options.sendsNote && note.length > 0) props.onNoteSent();
    setBusy(false);
  };
  const withNote = note.length > 0 ? { note } : {};

  const confirmCancel = () =>
    Alert.alert("Cancel feature?", "Running stages stop. You can reopen it later.", [
      { text: "Keep running", style: "cancel" },
      {
        text: "Cancel feature",
        style: "destructive",
        onPress: () => void run(() => cancel(target(action("cancel")))),
      },
    ]);

  const handleMenu = (id: string) => {
    if (id === "take-over") return void run(() => takeOver(target(action("take-over"))));
    if (id === "skip") return void run(() => skip(target(action("skip"))));
    if (id === "resume") return void run(() => resume(target(action("resume"))));
    if (id === "cancel") return confirmCancel();
    if (id.startsWith(SEND_BACK)) {
      return void run(
        () =>
          sendBack(
            target({ ...action("send-back"), stepId: id.slice(SEND_BACK.length), ...withNote }),
          ),
        { sendsNote: true },
      );
    }
    if (id.startsWith(RETRY_MODEL)) {
      const modelSelection = JSON.parse(id.slice(RETRY_MODEL.length)) as ModelSelection;
      return void run(() => retry(target({ ...action("retry"), modelSelection })));
    }
    if (id.startsWith(MARK_DONE)) {
      return void run(
        () =>
          markDone(
            target({
              ...action("mark-done"),
              outcome: id.slice(MARK_DONE.length),
              summary: note.length > 0 ? note : "Marked done by a person.",
            }),
          ),
        { sendsNote: true },
      );
    }
    if (id.startsWith(REOPEN_AT)) {
      return void run(() =>
        reopen(target({ ...action("reopen"), stepId: id.slice(REOPEN_AT.length) })),
      );
    }
  };

  const takeOverItem: MenuAction = { id: "take-over", title: "Take over" };
  const cancelItem: MenuAction = {
    id: "cancel",
    title: "Cancel feature",
    attributes: { destructive: true },
  };
  // A paused feature keeps showing what it waits on, so Resume rides along in More actions.
  const moreButton = (actions: MenuAction[]) => (
    <Menu
      accessibilityLabel="More actions"
      actions={
        snapshot.paused && kind !== "paused"
          ? [{ id: "resume", title: "Resume" }, ...actions]
          : actions
      }
      onPressAction={({ nativeEvent }) => handleMenu(nativeEvent.event)}
    >
      <RequestActionButton label="More actions" tone="secondary" disabled={disabled} />
    </Menu>
  );
  const hintNote = hint ? (
    <Text className="font-sans text-xs leading-normal text-warning-foreground">{hint}</Text>
  ) : null;

  switch (kind) {
    case "question":
      return (
        <ApprovalCardLayout
          kicker={`${stageName} asks`}
          title={crewOpenQuestion(snapshot) ?? ""}
          note={hintNote}
        >
          <RequestActionButton
            label="Answer"
            disabled={disabled}
            onPress={() => {
              if (note.length === 0) {
                setHint("Write your answer in the composer, then tap Answer.");
                return;
              }
              void run(() => answer(target({ ...action("answer"), text: note })), {
                sendsNote: true,
              });
            }}
          />
          {moreButton([takeOverItem, cancelItem])}
        </ApprovalCardLayout>
      );
    case "gate": {
      const copy = crewGateCopy(snapshot);
      return (
        <ApprovalCardLayout
          kicker={copy?.kicker ?? `${stageName} approval`}
          title={copy?.title ?? `${stageName} is ready`}
          detail={copy?.consequence}
          note={hintNote}
        >
          <RequestActionButton
            label="Approve"
            disabled={disabled}
            onPress={() =>
              void run(() => approve(target({ ...action("approve"), ...withNote })), {
                sendsNote: true,
              })
            }
          />
          <RequestActionButton
            label="Request changes"
            tone="secondary"
            disabled={disabled}
            onPress={() => {
              if (note.length === 0) {
                setHint(`Write what the ${role} should change in the composer, then tap again.`);
                return;
              }
              void run(() => requestChanges(target({ ...action("request-changes"), note })), {
                sendsNote: true,
              });
            }}
          />
          <RequestActionButton label="View diff" tone="secondary" onPress={props.onViewDiff} />
        </ApprovalCardLayout>
      );
    }
    case "failure": {
      const step = crewCurrentStep(snapshot);
      const targets = crewSendBackTargets(snapshot, stepId);
      return (
        <ApprovalCardLayout
          tone="danger"
          kicker={`${stageName} failed`}
          title={`Attempt ${step?.attempt ?? 1}`}
          detail={crewFailureDetail(snapshot)}
        >
          <RequestActionButton
            label="Retry"
            disabled={disabled}
            onPress={() => void run(() => retry(target(action("retry"))))}
          />
          <Menu
            accessibilityLabel="Retry with another model"
            actions={modelMenu(props.providers)}
            onPressAction={({ nativeEvent }) => handleMenu(nativeEvent.event)}
          >
            <RequestActionButton
              label="Retry with another model"
              tone="secondary"
              disabled={disabled}
            />
          </Menu>
          {moreButton([
            takeOverItem,
            ...(targets.length > 0
              ? [
                  {
                    id: "send-back",
                    title: "Send back to…",
                    subactions: targets.map((item) => ({
                      id: `${SEND_BACK}${item.stepId}`,
                      title: item.label,
                    })),
                  },
                ]
              : []),
            { id: "skip", title: "Skip stage" },
            cancelItem,
          ])}
        </ApprovalCardLayout>
      );
    }
    case "your-call": {
      const call = snapshot.yourCall;
      return (
        <ApprovalCardLayout
          kicker="Your call"
          title={
            call?.reason === "loop-limit"
              ? `${humanizeCrewId(call.stepId)} hit its limit for “${humanizeCrewId(call.outcome)}”`
              : "The feature ran its maximum number of stages"
          }
          detail="Accept the work as it is, or give it one more round."
        >
          <RequestActionButton
            label="Accept as is"
            disabled={disabled}
            onPress={() => void run(() => acceptAsIs(target(action("accept-as-is"))))}
          />
          <RequestActionButton
            label="One more round"
            tone="secondary"
            disabled={disabled}
            onPress={() => void run(() => oneMoreRound(target(action("one-more-round"))))}
          />
          {moreButton([takeOverItem, cancelItem])}
        </ApprovalCardLayout>
      );
    }
    case "taken-over": {
      const outcomes = crewStageOutcomes(snapshot.definition, stepId);
      return (
        <ApprovalCardLayout
          kicker="You're driving this stage"
          title={stageName}
          detail="The composer talks to this thread. Mark the stage done to hand your result on; your composer text becomes its summary."
        >
          <Menu
            accessibilityLabel="Mark stage done"
            actions={outcomes.map((outcome) => ({
              id: `${MARK_DONE}${outcome}`,
              title: humanizeCrewId(outcome),
            }))}
            onPressAction={({ nativeEvent }) => handleMenu(nativeEvent.event)}
          >
            <RequestActionButton label="Mark stage done" disabled={disabled} />
          </Menu>
          {moreButton([cancelItem])}
        </ApprovalCardLayout>
      );
    }
    case "paused":
      return (
        <ApprovalCardLayout kicker="Paused" title={snapshot.definition.name}>
          <RequestActionButton
            label="Resume"
            disabled={disabled}
            onPress={() => void run(() => resume(target(action("resume"))))}
          />
          {moreButton([cancelItem])}
        </ApprovalCardLayout>
      );
    case "queued":
      return (
        <ApprovalCardLayout
          kicker="Queued"
          title={humanizeCrewId(snapshot.stage?.stepId ?? stepId)}
          detail="Waiting for a free stage slot."
        >
          <RequestActionButton
            label="Start now"
            disabled={disabled}
            onPress={() => void run(() => startNow(target(base)))}
          />
          {moreButton([cancelItem])}
        </ApprovalCardLayout>
      );
    case "cancelled":
      return (
        <ApprovalCardLayout kicker="Cancelled" title={props.stage.title}>
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
            onPressAction={({ nativeEvent }) => handleMenu(nativeEvent.event)}
          >
            <RequestActionButton label="Reopen at…" tone="secondary" disabled={disabled} />
          </Menu>
        </ApprovalCardLayout>
      );
  }
}
