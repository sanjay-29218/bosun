import { useAtomValue } from "@effect/atom-react";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import type {
  Bot,
  BotTransferMode,
  BotTransferResult,
  EnvironmentId,
  PeerLinkSummary,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn, randomUUID } from "../../lib/utils";
import { botsEnvironment } from "../../state/bots";
import { offersLinkedEnvironmentsAtom, peerLinkEnvironment } from "../../state/peerLinks";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { LinkEnvironmentAction } from "../settings/LinkedEnvironmentsSettings";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { botTransferAutomationsLine, botTransferLeftOut } from "./bots.logic";

const OLDER_BOSUN = /^Update Bosun on /;

type Preview =
  | { readonly key: string; readonly status: "checking" }
  | { readonly key: string; readonly status: "ready"; readonly result: BotTransferResult }
  | { readonly key: string; readonly status: "failed"; readonly message: string };

/**
 * Copies a bot to one of its home's linked machines, or moves it there. Picking a machine checks
 * it with the server first, which says what comes along; the confirm button waits for that.
 */
export function BotTransferDialog({
  environmentId,
  homeLabel,
  bot,
  mode: initialMode,
  open,
  onOpenChange,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly homeLabel: string;
  readonly bot: Bot;
  readonly mode: BotTransferMode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: (result: BotTransferResult, mode: BotTransferMode) => void;
}) {
  const [running, setRunning] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A transfer that's running finishes before the dialog can close.
        if (!next && running) return;
        onOpenChange(next);
      }}
    >
      <DialogPopup showCloseButton={!running}>
        {/* Remounted per opening, so each one picks afresh under a new ID. */}
        {open ? (
          <TransferForm
            environmentId={environmentId}
            homeLabel={homeLabel}
            bot={bot}
            initialMode={initialMode}
            running={running}
            setRunning={setRunning}
            onCancel={() => onOpenChange(false)}
            onDone={onDone}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function TransferForm({
  environmentId,
  homeLabel,
  bot,
  initialMode,
  running,
  setRunning,
  onCancel,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly homeLabel: string;
  readonly bot: Bot;
  readonly initialMode: BotTransferMode;
  readonly running: boolean;
  readonly setRunning: (running: boolean) => void;
  readonly onCancel: () => void;
  readonly onDone: (result: BotTransferResult, mode: BotTransferMode) => void;
}) {
  const offered = useAtomValue(offersLinkedEnvironmentsAtom(environmentId));
  const links = useEnvironmentQuery(
    offered ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  const transfer = useAtomCommand(botsEnvironment.transfer, { reportFailure: false });
  const nowMinute = useNowMinute();
  // One ID per opening: Try again finishes or undoes the same transfer.
  const [newBotId] = useState(() => `bot-${randomUUID()}`);
  const [mode, setMode] = useState(initialMode);
  const [picked, setPicked] = useState<EnvironmentId | null>(null);
  // Machines found too old to take a bot, until the dialog closes.
  const [older, setOlder] = useState<ReadonlySet<EnvironmentId>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const list = links.data?.links ?? null;
  const reasonOf = (link: PeerLinkSummary) => {
    if (older.has(link.environmentId)) return `Update Bosun on ${link.label}`;
    const health = peerLinkHealth(link, DateTime.makeUnsafe(nowMinute));
    if (health.kind === "expired") return "Expired. Link it again.";
    if (health.kind === "unreachable") return health.detail ?? "Not answering right now";
    if (health.kind === "failing") return health.detail;
    if (link.access !== "full-access") {
      return `Needs full access. Link ${link.label} again with full access.`;
    }
    return null;
  };
  const enabled = (list ?? []).filter((link) => reasonOf(link) === null);
  const target =
    picked !== null && enabled.some((link) => link.environmentId === picked)
      ? picked
      : enabled.length === 1
        ? enabled[0]!.environmentId
        : null;
  const targetLabel = list?.find((link) => link.environmentId === target)?.label ?? null;
  const key = target === null ? null : `${mode}:${target}:${attempt}`;
  // Until its answer arrives, the picked mode and machine are being checked.
  const current: Preview | null =
    key === null
      ? null
      : preview !== null && preview.key === key
        ? preview
        : { key, status: "checking" };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server what this mode and machine would do; the answer for an older pick is dropped.
  useEffect(() => {
    if (key === null || target === null) return;
    let live = true;
    void transfer({
      environmentId,
      input: { botId: bot.id, targetEnvironmentId: target, newBotId, mode, dryRun: true },
    }).then((result) => {
      if (!live) return;
      if (result._tag === "Success") {
        setPreview({ key, status: "ready", result: result.value });
        return;
      }
      const message = formatEnvironmentQueryError(result.cause);
      if (OLDER_BOSUN.test(message)) setOlder((known) => new Set(known).add(target));
      setPreview({ key, status: "failed", message });
    });
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The key names the mode, machine and attempt; the command function is new each render.
  }, [key]);

  const confirm = async () => {
    if (target === null || current?.status !== "ready") return;
    setRunning(true);
    setFailure(null);
    const result = await transfer({
      environmentId,
      input: { botId: bot.id, targetEnvironmentId: target, newBotId, mode },
    });
    setRunning(false);
    if (result._tag === "Success") {
      onDone(result.value, mode);
      return;
    }
    setFailure(formatEnvironmentQueryError(result.cause));
  };

  // A move that hasn't finished. Pending: finish it by moving there again, or cancel it.
  // Confirmed: the copy runs there, so it can only finish, or stop waiting for a silent target.
  const moving = bot.movingTo ?? null;
  const movingLink =
    moving === null
      ? undefined
      : list?.find((link) => link.environmentId === moving.targetEnvironmentId);
  const pendingLabel = moving === null ? null : (movingLink?.label ?? "the other machine");
  const movingHealth =
    movingLink === undefined
      ? null
      : peerLinkHealth(movingLink, DateTime.makeUnsafe(nowMinute)).kind;
  const targetSilent =
    list !== null &&
    (movingLink === undefined || movingHealth === "unreachable" || movingHealth === "expired");
  // A confirmed move it can't finish, such as one whose copy is gone there, may stop waiting.
  const cannotFinish =
    moving !== null && target === moving.targetEnvironmentId && current?.status === "failed";
  const cancelPendingMove = async () => {
    if (moving === null || pendingLabel === null) return;
    const cancel = (how: "undo" | "forget") =>
      transfer({
        environmentId,
        input: {
          botId: bot.id,
          targetEnvironmentId: moving.targetEnvironmentId,
          newBotId,
          mode: "move",
          cancelMove: how,
        },
      });
    setFailure(null);
    let result;
    if (moving.state === "confirmed") {
      const confirmed = await requestConfirmDialog(
        `${pendingLabel} took ${bot.name} before it went quiet, so ${bot.name} may live there too.\nStop waiting and keep ${bot.name} here? Its automations stay off here; turn them on only once you're sure ${pendingLabel} doesn't run them.`,
        { variant: "destructive" },
      );
      if (confirmed !== true) return;
      setRunning(true);
      result = await cancel("forget");
    } else {
      setRunning(true);
      result = await cancel("undo");
      // Giving up without the target is offered only when it's silent; otherwise it said why.
      if (result._tag !== "Success" && targetSilent) {
        setRunning(false);
        const confirmed = await requestConfirmDialog(
          `${formatEnvironmentQueryError(result.cause)}\nCancel the move anyway? ${bot.name}'s automations stay off here; turn them on only once you're sure ${pendingLabel} doesn't run them.`,
          { variant: "destructive" },
        );
        if (confirmed !== true) return;
        setRunning(true);
        result = await cancel("forget");
      }
    }
    setRunning(false);
    if (result._tag !== "Success") {
      setFailure(formatEnvironmentQueryError(result.cause));
      return;
    }
    toastManager.add(
      result.value.warnings.length > 0
        ? {
            type: "warning",
            title: `Cancelled ${bot.name}'s move`,
            description: result.value.warnings.join(" "),
          }
        : { type: "success", title: `Cancelled ${bot.name}'s move`, description: "It stays here." },
    );
    onCancel();
  };

  const verb = mode === "move" ? "Move" : "Copy";
  const linkAction = canLink ? (
    <LinkEnvironmentAction environmentId={environmentId} label="Link another machine" />
  ) : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {verb} {bot.name} to another machine
        </DialogTitle>
        <DialogDescription>
          {bot.name} lives on {homeLabel}.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <fieldset disabled={running} className="min-w-0 space-y-5">
          {pendingLabel === null ? null : (
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertTitle>
                {bot.name}'s move to {pendingLabel} hasn't finished
              </AlertTitle>
              <AlertDescription>
                {moving?.state === "confirmed"
                  ? `${pendingLabel} already runs ${bot.name}. Move it to ${pendingLabel} again to finish removing it here.`
                  : `Move it to ${pendingLabel} again to finish, or cancel the move to keep it here.`}
              </AlertDescription>
              {moving?.state === "confirmed" && !targetSilent && !cannotFinish ? null : (
                <AlertAction>
                  <Button size="xs" variant="outline" onClick={() => void cancelPendingMove()}>
                    {moving?.state === "confirmed" ? "Stop waiting" : "Cancel move"}
                  </Button>
                </AlertAction>
              )}
            </Alert>
          )}
          <RadioGroup
            value={mode}
            onValueChange={(next) => {
              setMode(next as BotTransferMode);
              setFailure(null);
            }}
            aria-label="Copy or move"
          >
            <ModeOption
              value="copy"
              label="Copy"
              detail={`A separate ${bot.name} on the other machine. This one stays.`}
            />
            <ModeOption
              value="move"
              label="Move"
              detail={`${bot.name}, its home folder and automations leave ${homeLabel}.`}
            />
          </RadioGroup>
          {!offered ? (
            <div className="rounded-lg border border-dashed">
              <Empty size="compact">
                <EmptyHeader>
                  <EmptyTitle>Linked environments are off on {homeLabel}</EmptyTitle>
                  <EmptyDescription>
                    Turn them on in{" "}
                    <Link to="/settings/labs" className="underline underline-offset-2">
                      Settings → Labs
                    </Link>
                    .
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : links.error ? (
            <p className="text-xs text-destructive" role="status">
              Could not load linked machines: {links.error}
            </p>
          ) : list === null ? (
            <p className="text-xs text-muted-foreground" role="status">
              Loading linked machines…
            </p>
          ) : list.length === 0 ? (
            <div className="space-y-2">
              <div className="rounded-lg border border-dashed">
                <Empty size="compact">
                  <EmptyHeader>
                    <EmptyTitle>No linked machines</EmptyTitle>
                    <EmptyDescription>
                      Link another machine running Bosun, such as a VPS, first.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
              {canLink ? (
                <div className="flex justify-end">
                  <LinkEnvironmentAction environmentId={environmentId} label="Link a machine" />
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              <Label id="bot-transfer-target">To</Label>
              <RadioGroup
                value={target ?? ""}
                onValueChange={(next) => {
                  setPicked(next as EnvironmentId);
                  setFailure(null);
                }}
                aria-labelledby="bot-transfer-target"
              >
                <ul className="divide-y divide-border rounded-lg border bg-card">
                  {list.map((link) => (
                    <TargetRow key={link.environmentId} link={link} reason={reasonOf(link)} />
                  ))}
                </ul>
              </RadioGroup>
              {linkAction ? <div className="flex justify-end">{linkAction}</div> : null}
              {current?.status === "checking" ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                  <Spinner size="xs" />
                  Checking {targetLabel}…
                </p>
              ) : current?.status === "failed" ? (
                <Alert variant={OLDER_BOSUN.test(current.message) ? "warning" : "error"}>
                  <TriangleAlertIcon />
                  <AlertDescription>{current.message}</AlertDescription>
                  {OLDER_BOSUN.test(current.message) ? null : (
                    <AlertAction>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setAttempt((count) => count + 1)}
                      >
                        Try again
                      </Button>
                    </AlertAction>
                  )}
                </Alert>
              ) : current?.status === "ready" && targetLabel !== null ? (
                <TransferPreview
                  mode={mode}
                  bot={bot}
                  homeLabel={homeLabel}
                  targetLabel={targetLabel}
                  result={current.result}
                />
              ) : null}
            </div>
          )}
          {failure !== null ? (
            <Alert variant="error">
              <TriangleAlertIcon />
              <AlertTitle>
                Couldn't {mode} {bot.name}
              </AlertTitle>
              <AlertDescription>{failure}</AlertDescription>
              <AlertAction>
                <Button size="xs" variant="outline" onClick={() => void confirm()}>
                  Try again
                </Button>
              </AlertAction>
            </Alert>
          ) : null}
        </fieldset>
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" disabled={running} onClick={onCancel}>
          {offered && list !== null && list.length > 0 ? "Cancel" : "Close"}
        </Button>
        {offered && list !== null && list.length > 0 ? (
          <Button disabled={running || current?.status !== "ready"} onClick={() => void confirm()}>
            {running ? <Spinner /> : null}
            {running
              ? `${mode === "move" ? "Moving" : "Copying"} to ${targetLabel}…`
              : targetLabel === null
                ? verb
                : `${verb} to ${targetLabel}`}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}

function ModeOption(props: {
  readonly value: BotTransferMode;
  readonly label: string;
  readonly detail: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <Radio value={props.value} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium leading-4">{props.label}</span>
        <span className="text-xs text-muted-foreground">{props.detail}</span>
      </span>
    </label>
  );
}

/** A linked machine with its health; disabled with its reason when it can't take a bot. */
function TargetRow({
  link,
  reason,
}: {
  readonly link: PeerLinkSummary;
  readonly reason: string | null;
}) {
  const nowMinute = useNowMinute();
  const health = peerLinkHealth(link, DateTime.makeUnsafe(nowMinute));
  return (
    <li>
      <label
        className={cn(
          "flex items-center gap-3 px-3 py-2.5",
          reason === null ? "cursor-pointer" : "cursor-not-allowed",
        )}
      >
        <Radio value={link.environmentId} disabled={reason !== null} />
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            health.kind === "reachable"
              ? "bg-success"
              : health.kind === "expired" || health.kind === "failing"
                ? "bg-destructive"
                : "bg-muted-foreground/30",
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            reason !== null && "text-muted-foreground",
          )}
        >
          {link.label}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{reason ?? "Reachable"}</span>
      </label>
    </li>
  );
}

/** What the check said would happen, in plain sections; empty ones are left out. */
function TransferPreview({
  mode,
  bot,
  homeLabel,
  targetLabel,
  result,
}: {
  readonly mode: BotTransferMode;
  readonly bot: Bot;
  readonly homeLabel: string;
  readonly targetLabel: string;
  readonly result: BotTransferResult;
}) {
  const automations = botTransferAutomationsLine(mode, result.automations, targetLabel);
  const comesAlong = result.projects.filter((project) => project.outcome === "comes-along");
  const leftOut = botTransferLeftOut(result.projects);
  const projectCount = result.projects.length;
  return (
    <div className="space-y-4 pt-1">
      {mode === "copy" ? (
        projectCount > 0 ? (
          <PreviewSection title="Projects">
            <p className="text-sm">
              {projectCount === 1 ? "1 project stays" : `${projectCount} projects stay`} with{" "}
              {bot.name} on {homeLabel}. Add projects to the copy from its Projects tab.
            </p>
          </PreviewSection>
        ) : null
      ) : (
        <>
          {comesAlong.length > 0 ? (
            <PreviewSection title={`Comes along · ${comesAlong.length}`}>
              {comesAlong.map((project) => (
                <ProjectLine
                  key={`${project.environmentId}:${project.projectId}`}
                  title={project.title}
                  machine={project.environmentLabel}
                />
              ))}
            </PreviewSection>
          ) : null}
          {leftOut.count > 0 ? (
            <PreviewSection title={`Left without a bot · ${leftOut.count}`}>
              {leftOut.machines.map((machine) => (
                <div key={machine.environmentId} className="space-y-1">
                  {machine.projects.map((project) => (
                    <ProjectLine
                      key={project.projectId}
                      title={project.title}
                      machine={machine.label}
                    />
                  ))}
                  <p className="text-xs text-muted-foreground">
                    {targetLabel} has no link to {machine.label}. Link {machine.label} from{" "}
                    {targetLabel} first to bring them along.
                  </p>
                </div>
              ))}
            </PreviewSection>
          ) : null}
        </>
      )}
      {mode === "move" && result.unchecked.length > 0 ? (
        <PreviewSection title={`Couldn't check · ${result.unchecked.length}`}>
          {result.unchecked.map((machine) => (
            <p key={machine.environmentId} className="text-sm">
              {machine.label} didn't answer. Its projects may still name {bot.name}.
            </p>
          ))}
        </PreviewSection>
      ) : null}
      {result.automations.copied > 0 ? (
        <PreviewSection title="Automations">
          {automations === null ? null : <p className="text-sm">{automations}</p>}
          {result.automations.needAttention.map((item) => (
            <p key={item.title} className="flex items-start gap-2 text-sm">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>
                <span className="font-medium">{item.title}:</span> {item.reason}
              </span>
            </p>
          ))}
        </PreviewSection>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {mode === "move"
          ? `${bot.name}'s thread on ${homeLabel} is deleted. It starts a fresh one on ${targetLabel} and keeps its memory, which lives in its home folder.`
          : "Its instructions, model, tools, access, look and home folder are copied. The two aren't kept in sync."}
      </p>
    </div>
  );
}

function PreviewSection(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function ProjectLine(props: { readonly title: string; readonly machine: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="truncate">{props.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{props.machine}</span>
    </div>
  );
}
