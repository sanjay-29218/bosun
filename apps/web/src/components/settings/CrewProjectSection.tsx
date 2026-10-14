import { useNavigate } from "@tanstack/react-router";
import { projectBotId } from "@t3tools/client-runtime/state/bot-rail";
import { CREW_DISPATCH_STATE, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import { useMemo, useState } from "react";

import { botsEnvironment } from "../../state/bots";
import { rolesEnvironment } from "../../state/roles";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function CrewProjectSection(props: { readonly project: SidebarProjectGroupMember }) {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const environmentId = props.project.environmentId;
  const projectId = props.project.id;
  const environmentLabel = props.project.environmentLabel ?? "This environment";
  const serverConfig = environments.find(
    (environment) => environment.environmentId === environmentId,
  )?.serverConfig;
  const defaultModelSelection = resolveDefaultProviderModelSelection(
    serverConfig?.providers ?? [],
    resolveProjectSettings(
      serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
      projectId,
      props.project,
    ).settings.defaultModelSelection,
  );
  const snapshot = useEnvironmentQuery(
    rolesEnvironment.snapshot({
      environmentId,
      input: { projectId },
    }),
  );
  // Work started here runs as the bot that owns the project.
  const bots = useEnvironmentQuery(
    serverConfig?.environment.capabilities.bots === true
      ? botsEnvironment.list({ environmentId, input: {} })
      : null,
  );
  const ownerName =
    bots.data?.find((bot) => bot.id === projectBotId(props.project))?.name ?? "Captain";
  const start = useAtomCommand(rolesEnvironment.start);
  const answer = useAtomCommand(rolesEnvironment.answer);
  const cancel = useAtomCommand(rolesEnvironment.cancel);
  const retry = useAtomCommand(rolesEnvironment.retry);
  const [taskText, setTaskText] = useState("");
  const [answerByRequest, setAnswerByRequest] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const members = useMemo(
    () => new Map(snapshot.data?.members.map((member) => [member.id, member.name]) ?? []),
    [snapshot.data?.members],
  );
  const runs = snapshot.data?.runs ?? [];
  const handoffs = snapshot.data?.handoffs ?? [];
  const pendingQuestions = handoffs.filter((handoff) => handoff.status === "needs-input");

  const startOwner = async () => {
    const task = taskText.trim();
    if (!task || !defaultModelSelection || busyId) return;
    setActionError(null);
    setBusyId("start");
    try {
      const result = await start({
        environmentId,
        input: {
          id: `bot-captain:${randomUUID()}`,
          projectId,
          modelSelection: defaultModelSelection,
          taskText: task,
        },
      });
      if (result._tag === "Success") {
        setTaskText("");
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: result.value.threadId },
        });
      } else {
        setActionError(Cause.pretty(result.cause));
      }
    } finally {
      setBusyId(null);
    }
  };

  const answerQuestion = async (id: string) => {
    const text = answerByRequest[id]?.trim();
    if (!text || busyId) return;
    setActionError(null);
    setBusyId(id);
    try {
      const result = await answer({
        environmentId,
        input: { projectId, requestId: id, text },
      });
      if (result._tag === "Success") {
        setAnswerByRequest((current) => ({ ...current, [id]: "" }));
        snapshot.refresh();
      } else {
        setActionError(Cause.pretty(result.cause));
      }
    } finally {
      setBusyId(null);
    }
  };

  const cancelRequest = async (id: string) => {
    if (busyId) return;
    setActionError(null);
    setBusyId(id);
    try {
      const result = await cancel({
        environmentId,
        input: { projectId, requestId: id },
      });
      if (result._tag === "Success") snapshot.refresh();
      else setActionError(Cause.pretty(result.cause));
    } finally {
      setBusyId(null);
    }
  };

  const retryRequest = async (id: string) => {
    if (busyId) return;
    setActionError(null);
    setBusyId(id);
    try {
      const result = await retry({
        environmentId,
        input: { projectId, requestId: id },
      });
      if (result._tag === "Success") snapshot.refresh();
      else setActionError(Cause.pretty(result.cause));
    } finally {
      setBusyId(null);
    }
  };

  const openRun = (threadId: (typeof runs)[number]["threadId"]) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };

  return (
    <SettingsSection title={`Crew activity · ${environmentLabel}`}>
      <Tooltip>
        <TooltipTrigger render={<p className="truncate px-3 pb-2 text-xs text-muted-foreground" />}>
          {props.project.workspaceRoot}
        </TooltipTrigger>
        <TooltipPopup variant="code">{props.project.workspaceRoot}</TooltipPopup>
      </Tooltip>
      <SettingsRow
        title={ownerName}
        description={`Give ${ownerName} a project task. Its Manager and Builder runs stay linked below.`}
        control={
          <span className="text-xs text-muted-foreground">
            {defaultModelSelection ? "Ready" : "No available model"}
          </span>
        }
      />
      <div className="space-y-2 px-3 pb-3">
        <Textarea
          aria-label={`Task for ${ownerName} on ${environmentLabel}`}
          value={taskText}
          onChange={(event) => setTaskText(event.target.value)}
          placeholder="What should the crew do in this project?"
          maxLength={8000}
          rows={3}
        />
        <Button
          size="sm"
          disabled={!defaultModelSelection || !taskText.trim() || busyId !== null}
          onClick={() => void startOwner()}
        >
          Start {ownerName}
        </Button>
      </div>
      {snapshot.error ? (
        <p className="px-3 pb-3 text-sm text-destructive">{snapshot.error}</p>
      ) : null}
      {actionError ? <p className="px-3 pb-3 text-sm text-destructive">{actionError}</p> : null}
      {pendingQuestions.length > 0 ? (
        <div className="space-y-3 px-3 pb-3">
          <h3 className="text-sm font-medium">Needs your answer</h3>
          {pendingQuestions.map((handoff) => (
            <div key={handoff.id} className="space-y-2 rounded-lg border border-border p-3">
              <p className="text-sm">{handoff.questionText}</p>
              <Textarea
                aria-label={`Answer request ${handoff.id}`}
                value={answerByRequest[handoff.id] ?? ""}
                onChange={(event) =>
                  setAnswerByRequest((current) => ({
                    ...current,
                    [handoff.id]: event.target.value,
                  }))
                }
                maxLength={8000}
                rows={2}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={!answerByRequest[handoff.id]?.trim() || busyId !== null}
                  onClick={() => void answerQuestion(handoff.id)}
                >
                  Send answer
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId !== null}
                  onClick={() => void cancelRequest(handoff.id)}
                >
                  Cancel request
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {runs.length > 0 ? (
        <div className="space-y-1 px-3 pb-3">
          <h3 className="text-sm font-medium">Recent runs</h3>
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => openRun(run.threadId)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{members.get(run.memberId) ?? run.memberId}</span>
                {run.lastError ? (
                  <span className="block truncate text-xs text-destructive">{run.lastError}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {run.dispatchState === CREW_DISPATCH_STATE.QUEUED
                  ? CREW_DISPATCH_STATE.QUEUED
                  : run.turnState}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {handoffs.length > 0 ? (
        <div className="space-y-1 px-3 pb-3">
          <h3 className="text-sm font-medium">Requests</h3>
          {handoffs.map((handoff) => (
            <div
              key={handoff.id}
              className="flex items-center justify-between gap-3 px-2 py-1 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {members.get(handoff.targetMemberId) ?? handoff.targetMemberId}:{" "}
                  {handoff.taskText}
                </span>
                {handoff.lastError || handoff.responseText ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {handoff.lastError ?? handoff.responseText}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{handoff.status}</span>
              {handoff.status === "failed" || handoff.status === "cancelled" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId !== null}
                  onClick={() => void retryRequest(handoff.id)}
                >
                  Retry
                </Button>
              ) : handoff.status === "queued" || handoff.status === "running" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId !== null}
                  onClick={() => void cancelRequest(handoff.id)}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </SettingsSection>
  );
}
