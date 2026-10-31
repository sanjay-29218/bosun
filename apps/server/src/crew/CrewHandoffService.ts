import {
  headquartersBotId,
  type ModelSelection,
  type ProjectId,
  type ThreadCrewHandoff,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";

import * as BotStore from "../bots/BotStore.ts";
import { FeatureWorkspaces } from "../features/FeatureWorkspaces.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CrewService, managedProjectId, type CrewServiceError } from "./CrewService.ts";
import { CrewStore, type CrewMember, type CrewRun, type CrewRunSummary } from "./CrewStore.ts";
import { CrewHandoffStore, type CrewHandoff } from "./CrewHandoffStore.ts";
import { CrewThreadRuntime } from "./CrewThreadRuntime.ts";

export class CrewHandoffError extends Error {
  readonly _tag = "CrewHandoffError";
}

export interface DelegateCrewInput {
  readonly id: string;
  readonly sourceThreadId: ThreadId;
  readonly targetMemberId: string;
  /**
   * The project the work runs on, checked against the target's. A bot may delegate into any
   * project it owns; everyone else only into their own run's project.
   */
  readonly projectId?: ProjectId;
  readonly taskText: string;
  readonly contextText?: string;
  /**
   * The workflow bound this source to the project when the feature started, so the bot's
   * headquarters keeps leading it after the project moves to another bot.
   */
  readonly boundByWorkflow?: boolean;
  /** Runs the target bot on another model, as Retry with another model does. */
  readonly modelSelection?: ModelSelection;
}

export interface CrewHandoffServiceShape {
  readonly delegate: (
    input: DelegateCrewInput,
  ) => Effect.Effect<CrewHandoff, CrewServiceError | CrewHandoffError>;
  readonly respond: (
    threadId: ThreadId,
    outcome: "completed" | "failed",
    summary: string,
  ) => Effect.Effect<CrewHandoff, CrewHandoffError | CrewServiceError>;
  readonly ask: (
    threadId: ThreadId,
    question: string,
  ) => Effect.Effect<CrewHandoff, CrewHandoffError | CrewServiceError>;
  readonly answer: (
    id: string,
    answer: string,
  ) => Effect.Effect<CrewHandoff, CrewHandoffError | CrewServiceError>;
  readonly answerFromBot: (
    threadId: ThreadId,
    id: string,
    answer: string,
  ) => Effect.Effect<CrewHandoff, CrewHandoffError | CrewServiceError>;
  readonly cancel: (id: string) => Effect.Effect<CrewHandoff, CrewHandoffError | CrewServiceError>;
  readonly retry: (id: string) => Effect.Effect<CrewHandoff, CrewHandoffError | CrewServiceError>;
  /** A person's answer, cancel or retry on a request, refused unless it is on `projectId`. */
  readonly actInProject: (input: {
    readonly projectId: ProjectId;
    readonly requestId: string;
    readonly action: "answer" | "cancel" | "retry";
    readonly text?: string | undefined;
  }) => Effect.Effect<CrewHandoff, CrewHandoffError | CrewServiceError>;
  /** A project's crew, its recent runs and requests, after settling finished work. */
  readonly projectSnapshot: (projectId: ProjectId) => Effect.Effect<
    {
      readonly members: ReadonlyArray<CrewMember>;
      readonly runs: ReadonlyArray<CrewRunSummary>;
      readonly handoffs: ReadonlyArray<CrewHandoff>;
    },
    CrewHandoffError | CrewServiceError
  >;
  readonly get: (id: string) => Effect.Effect<CrewHandoff | null, CrewServiceError>;
  readonly listByRun: (
    runId: string,
  ) => Effect.Effect<ReadonlyArray<CrewHandoff>, CrewServiceError>;
  readonly reconcile: () => Effect.Effect<void, CrewServiceError>;
  readonly refreshProject: (projectId: ProjectId) => Effect.Effect<void, CrewServiceError>;
  readonly refreshRun: (runId: string) => Effect.Effect<void, CrewServiceError>;
}

export class CrewHandoffService extends Context.Service<
  CrewHandoffService,
  CrewHandoffServiceShape
>()("t3/crew/CrewHandoffService") {}

const bounded = (value: string, name: string, max: number) => {
  const text = value.trim();
  if (text.length === 0 || text.length > max) {
    throw new CrewHandoffError(`${name} must contain 1-${max} characters`);
  }
  return text;
};

const SHOWN_OPEN = new Set<CrewHandoff["status"]>(["queued", "running", "needs-input"]);
const firstLine = (text: string | null) => text?.split("\n", 1)[0]?.trim().slice(0, 200) || null;

/** Workflow stages delegate under this prefix; their roles set their own access and model. */
export const WORKFLOW_HANDOFF_PREFIX = "workflow:";
const isWorkflowHandoffId = (id: string) => id.startsWith(WORKFLOW_HANDOFF_PREFIX);
const ENDED: ReadonlySet<CrewHandoff["status"]> = new Set(["completed", "failed", "cancelled"]);

const sameRequest = (handoff: CrewHandoff, input: DelegateCrewInput, source: CrewRun) =>
  handoff.sourceRunId === source.id &&
  handoff.targetMemberId === input.targetMemberId &&
  (input.projectId === undefined || handoff.projectId === input.projectId) &&
  handoff.taskText === input.taskText.trim() &&
  handoff.contextText === (input.contextText?.trim() ?? "") &&
  JSON.stringify(handoff.modelSelection ?? null) === JSON.stringify(input.modelSelection ?? null);

export const CrewHandoffServiceLive = Layer.effect(
  CrewHandoffService,
  Effect.gen(function* () {
    const handoffs = yield* CrewHandoffStore;
    const runs = yield* CrewStore;
    const crew = yield* CrewService;
    const runtime = yield* CrewThreadRuntime;
    const bots = yield* BotStore.BotStore;
    const settings = yield* ServerSettingsService;
    const featureWorkspaces = yield* FeatureWorkspaces;

    const deliver = Effect.fn("CrewHandoffService.deliver")(function* (handoff: CrewHandoff) {
      if (handoff.notificationState !== "queued") return;
      const recipientRunId =
        handoff.status === "running" ? handoff.targetRunId : handoff.sourceRunId;
      const recipient = yield* runs.getRun(recipientRunId);
      if (!recipient) return;
      // A run whose own handoff ended was finished or replaced; waking it starts work twice.
      if (handoff.status !== "running") {
        const own = yield* handoffs.getForTargetRun(recipient.id);
        if (own && ENDED.has(own.status)) {
          yield* handoffs.markDelivered(handoff.id, handoff.noticeVersion);
          return;
        }
      }
      // A headquarters follows its bot's current settings, so its next turn uses them.
      if (headquartersBotId(recipient.threadId) !== null) {
        yield* runtime.syncSettings(
          recipient.threadId,
          recipient.runtimeMode,
          recipient.modelSelection,
        );
      }
      // A lead thread can follow many handoffs, so name the task each notice is about.
      const about = `${handoff.id} (${handoff.taskText.split("\n", 1)[0]!.slice(0, 160)})`;
      const prompt =
        handoff.status === "running"
          ? `Crew answer for handoff ${handoff.id}: ${handoff.responseText ?? ""}`
          : handoff.status === "needs-input"
            ? `Crew handoff ${about} needs input from you: ${handoff.questionText ?? ""}`
            : `Crew handoff ${about} is ${handoff.status}. ${handoff.responseText ?? ""}`;
      yield* runtime.notify(
        recipient.threadId,
        handoff.id,
        handoff.noticeVersion,
        recipient.id,
        recipient.runtimeMode,
        prompt,
        handoff.updatedAt,
      );
      yield* handoffs.markDelivered(handoff.id, handoff.noticeVersion);
    });

    /** Refreshes the "Waiting on" list of the thread that sent handoffs from `sourceRunId`. */
    const showOnSender = Effect.fn("CrewHandoffService.showOnSender")(function* (
      sourceRunId: string,
    ) {
      const source = yield* runs.getRun(sourceRunId);
      if (!source) return;
      const sent = yield* handoffs.listBySourceRun(sourceRunId);
      const open = sent.filter((handoff) => SHOWN_OPEN.has(handoff.status));
      const latest = sent.reduce<CrewHandoff | null>(
        (newest, handoff) =>
          newest === null || handoff.updatedAt > newest.updatedAt ? handoff : newest,
        null,
      );
      const shown = open.length > 0 ? open : latest?.status === "failed" ? [latest] : [];
      const items = yield* Effect.forEach(shown, (handoff) =>
        Effect.gen(function* () {
          const member = yield* runs.getMember(handoff.targetMemberId);
          const target = yield* runs.getRun(handoff.targetRunId);
          return {
            id: handoff.id,
            member: member?.name ?? "A crew member",
            threadId: target?.threadId ?? null,
            status: handoff.status as ThreadCrewHandoff["status"],
            task: firstLine(handoff.taskText) ?? "",
            question: handoff.status === "needs-input" ? firstLine(handoff.questionText) : null,
            error:
              handoff.status === "failed"
                ? firstLine(handoff.lastError ?? handoff.responseText)
                : null,
            createdAt: handoff.createdAt,
            updatedAt: handoff.updatedAt,
          } satisfies ThreadCrewHandoff;
        }),
      );
      yield* runtime.showHandoffs(source.threadId, items);
    });
    /** Every status change updates the sender's thread. */
    const changed = (handoff: Pick<CrewHandoff, "id" | "sourceRunId">) =>
      showOnSender(handoff.sourceRunId).pipe(Effect.result);

    const requireRun = Effect.fn("CrewHandoffService.requireRun")(function* (
      threadId: ThreadId,
      grant: string,
    ) {
      const runId = yield* handoffs.getRunByThread(threadId);
      const run = runId ? yield* runs.getRun(runId) : null;
      if (!run || !run.allowedTools.includes(grant)) {
        return yield* Effect.fail(new CrewHandoffError(`This thread cannot use ${grant}`));
      }
      return run;
    });

    const requireIncoming = (run: CrewRun) =>
      handoffs
        .getForTargetRun(run.id)
        .pipe(
          Effect.filterOrFail(
            Predicate.isNotNull,
            () => new CrewHandoffError("This run has no incoming handoff"),
          ),
        );

    /**
     * A delegated handoff starts while crew runs that are working stay under the crew limit, first
     * in, first out. A run waiting on its own handoffs isn't working, so delegating always frees
     * the delegator's place. Workflow stages take feature slots instead.
     */
    const hasRoom = Effect.fn("CrewHandoffService.hasRoom")(function* (handoff: CrewHandoff) {
      if (isWorkflowHandoffId(handoff.id)) return true;
      const { crew: limits } = yield* settings.getSettings.pipe(
        Effect.mapError(() => new CrewHandoffError("Crew limits are unavailable")),
      );
      const running = yield* handoffs.listRunning();
      const pending = yield* handoffs.listPending();
      const waiting = new Set([...running, ...pending].map((other) => other.sourceRunId));
      const working = running.filter((other) => !waiting.has(other.targetRunId)).length;
      const earlier = pending.some(
        (other) =>
          !isWorkflowHandoffId(other.id) &&
          (other.createdAt < handoff.createdAt ||
            (other.createdAt === handoff.createdAt && other.id < handoff.id)),
      );
      return working < limits.maxRunningStageThreads && !earlier;
    });

    const startQueued = Effect.fn("CrewHandoffService.startQueued")(function* (
      handoff: CrewHandoff,
    ) {
      if (handoff.status !== "queued") return handoff;
      if (!(yield* hasRoom(handoff))) return handoff;
      const sourceRun = yield* runs.getRun(handoff.sourceRunId);
      const sourceMember = sourceRun ? yield* runs.getActor(sourceRun.memberId) : null;
      const targetMember = yield* runs.getMember(handoff.targetMemberId);
      if (
        !sourceRun ||
        !sourceMember?.enabled ||
        !targetMember?.enabled ||
        !(yield* runs.canDelegate(sourceMember.id, targetMember.id, handoff.projectId))
      ) {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* handoffs.transition(
          handoff.id,
          ["queued"],
          "failed",
          now,
          { lastError: "Delegation permission is unavailable" },
          true,
        );
        const updated = (yield* handoffs.get(handoff.id))!;
        yield* deliver(updated).pipe(Effect.result);
        yield* changed(updated);
        return updated;
      }
      // Plain handoffs carry the delegator's current access and model; stages use their role's.
      const carried = isWorkflowHandoffId(handoff.id)
        ? null
        : yield* runtime.settings(sourceRun.threadId);
      // A stage works in its feature's workspace; a helper where its delegator works.
      const workspace = isWorkflowHandoffId(handoff.id)
        ? yield* featureWorkspaces
            .forStageHandoff(handoff.id)
            .pipe(Effect.mapError((error) => new CrewHandoffError(error.message)))
        : yield* runtime
            .workspace(sourceRun.threadId)
            .pipe(
              Effect.map((source) =>
                source?.projectId === handoff.projectId ? source.workspace : null,
              ),
            );
      yield* crew.createRun({
        id: handoff.targetRunId,
        memberId: handoff.targetMemberId,
        projectId: handoff.projectId,
        taskText: `${handoff.taskText}${handoff.contextText ? `\n\nContext:\n${handoff.contextText}` : ""}`,
        ...(handoff.modelSelection ? { modelSelection: handoff.modelSelection } : {}),
        ...(carried ? { carried } : {}),
        ...(workspace ? { workspace } : {}),
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* handoffs.transition(handoff.id, ["queued"], "running", now);
      yield* changed(handoff);
      return (yield* handoffs.get(handoff.id))!;
    });

    // A workflow stage's thread is tagged with its feature by the workflow instead.
    const tagThread = Effect.fn("CrewHandoffService.tagThread")(
      function* (handoff: CrewHandoff, sourceThreadId: ThreadId) {
        const run = yield* runs.getRun(handoff.targetRunId);
        const member = yield* runs.getMember(handoff.targetMemberId);
        if (!run || !member) return;
        yield* runtime.tagHandoff({
          threadId: run.threadId,
          sourceThreadId,
          request: {
            id: handoff.id,
            title: handoff.taskText
              .split("\n", 1)[0]!
              .trim()
              .replace(/[.:]+$/, "")
              .slice(0, 120),
            member: member.name,
          },
        });
      },
      Effect.catch((error) => Effect.logWarning("Handoff thread tag failed", { error })),
    );

    /** Starts queued handoffs in order while the crew limit has room. */
    const startWaiting = Effect.fn("CrewHandoffService.startWaiting")(function* () {
      for (const handoff of yield* handoffs.listPending()) {
        if (isWorkflowHandoffId(handoff.id)) continue;
        const started = yield* startQueued(handoff).pipe(Effect.result);
        if (started._tag === "Failure") continue;
        if (started.success.status === "queued") return;
        const source = yield* runs.getRun(handoff.sourceRunId);
        if (source) yield* tagThread(started.success, source.threadId);
      }
    });

    const delegate: CrewHandoffServiceShape["delegate"] = Effect.fn("CrewHandoffService.delegate")(
      function* (input) {
        const id = yield* Effect.try({
          try: () => bounded(input.id, "Request ID", 128),
          catch: () => new CrewHandoffError("Invalid request ID"),
        });
        const taskText = yield* Effect.try({
          try: () => bounded(input.taskText, "Task", 8_000),
          catch: () => new CrewHandoffError("Invalid task"),
        });
        const contextText = input.contextText?.trim() ?? "";
        if (contextText.length > 4_000) {
          return yield* Effect.fail(new CrewHandoffError("Context exceeds 4,000 characters"));
        }
        const sourceRunId = yield* handoffs.getRunByThread(input.sourceThreadId);
        const source = sourceRunId ? yield* runs.getRun(sourceRunId) : null;
        if (!source) return yield* Effect.fail(new CrewHandoffError("This thread has no crew run"));
        const existing = yield* handoffs.get(id);
        if (existing) {
          if (!sameRequest(existing, { ...input, taskText, contextText }, source)) {
            return yield* Effect.fail(
              new CrewHandoffError("Request ID belongs to another handoff"),
            );
          }
          const started = yield* startQueued(existing);
          if (!input.boundByWorkflow) yield* tagThread(started, source.threadId);
          return started;
        }
        const parent = yield* handoffs.getForTargetRun(source.id);
        // A workflow starts each stage from the manager that started it, long after that
        // manager's own handoff ended, so only free-hand delegation is held back here.
        if (!input.boundByWorkflow && parent && ENDED.has(parent.status)) {
          return yield* Effect.fail(
            new CrewHandoffError("This run's own handoff has ended, so it can't start new work"),
          );
        }
        const sourceMember = yield* runs.getActor(source.memberId);
        // A bot reaches into the other projects it owns; everyone else stays on its run's
        // project, as does a bot run started before its project moved away.
        const bot = sourceMember ? yield* bots.get(sourceMember.id) : null;
        const managed = managedProjectId(input.targetMemberId);
        if (bot && managed && (yield* bots.projectOwner(managed)) === bot.id) {
          yield* crew.ensureProjectManager(managed);
        }
        const targetMember = yield* runs.getMember(input.targetMemberId);
        const projectId = targetMember?.projectId ?? null;
        if (
          !sourceMember ||
          !targetMember?.enabled ||
          projectId === null ||
          (input.projectId !== undefined && input.projectId !== projectId) ||
          // A headquarters lives outside the projects it leads (or in one that may move), so
          // it always needs to own the target project, unless its workflow bound it there.
          ((projectId !== source.projectId || headquartersBotId(source.threadId) !== null) &&
            !input.boundByWorkflow &&
            (!bot || (yield* bots.projectOwner(projectId)) !== bot.id))
        ) {
          return yield* Effect.fail(
            new CrewHandoffError("Target crew member is unavailable for this project"),
          );
        }
        if (!(yield* runs.canDelegate(sourceMember.id, targetMember.id, projectId))) {
          return yield* Effect.fail(new CrewHandoffError("Delegation is not permitted"));
        }
        const depth = (parent?.depth ?? 0) + 1;
        if (depth > 8) {
          return yield* Effect.fail(new CrewHandoffError("Delegation depth exceeded"));
        }
        if (parent) {
          const ancestors = yield* handoffs.listAncestors(parent.id);
          if (ancestors.some((ancestor) => ancestor.targetMemberId === targetMember.id)) {
            return yield* Effect.fail(new CrewHandoffError("Delegation cycle rejected"));
          }
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const handoff: CrewHandoff = {
          id,
          parentId: parent?.id ?? null,
          sourceRunId: source.id,
          targetMemberId: targetMember.id,
          targetRunId: `bot-handoff:${id}`,
          projectId,
          taskText,
          contextText,
          depth,
          status: "queued",
          responseText: null,
          questionText: null,
          lastError: null,
          notificationState: "none",
          noticeVersion: 0,
          attempt: 1,
          createdAt: now,
          updatedAt: now,
          modelSelection: input.modelSelection ?? null,
        };
        yield* handoffs.insert(handoff);
        const persisted = yield* handoffs.get(id);
        if (!persisted || !sameRequest(persisted, { ...input, taskText, contextText }, source)) {
          return yield* Effect.fail(new CrewHandoffError("Request ID belongs to another handoff"));
        }
        const started = yield* startQueued(persisted);
        if (!input.boundByWorkflow) yield* tagThread(started, source.threadId);
        return started;
      },
    );

    const updateFromRecipient = Effect.fn("CrewHandoffService.updateFromRecipient")(function* (
      threadId: ThreadId,
      grant: "crew.respond" | "crew.ask",
      status: "completed" | "failed" | "needs-input",
      text: string,
    ) {
      const value = yield* Effect.try({
        try: () => bounded(text, status === "needs-input" ? "Question" : "Summary", 8_000),
        catch: () => new CrewHandoffError("Invalid response text"),
      });
      const run = yield* requireRun(threadId, grant);
      const handoff = yield* requireIncoming(run);
      if (handoff.status === status && (handoff.responseText ?? handoff.questionText) === value) {
        return handoff;
      }
      if (handoff.status !== "running") {
        return yield* Effect.fail(new CrewHandoffError("Handoff is not running"));
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const moved = yield* handoffs.transition(
        handoff.id,
        ["running"],
        status,
        now,
        status === "needs-input" ? { questionText: value } : { responseText: value },
        true,
      );
      if (!moved) return yield* Effect.fail(new CrewHandoffError("Handoff changed concurrently"));
      const updated = (yield* handoffs.get(handoff.id))!;
      yield* deliver(updated).pipe(Effect.result);
      yield* changed(updated);
      yield* startWaiting().pipe(Effect.result);
      return (yield* handoffs.get(handoff.id))!;
    });

    const answer: CrewHandoffServiceShape["answer"] = Effect.fn("CrewHandoffService.answer")(
      function* (id, answerText) {
        const value = yield* Effect.try({
          try: () => bounded(answerText, "Answer", 8_000),
          catch: () => new CrewHandoffError("Invalid answer"),
        });
        const current = yield* handoffs.get(id);
        if (current?.status === "running" && current.responseText === value) return current;
        const recipient = current ? yield* runs.getRun(current.targetRunId) : null;
        if (!recipient) return yield* Effect.fail(new CrewHandoffError("Recipient run not found"));
        const handoff = yield* requireIncoming(recipient);
        if (handoff.status !== "needs-input") {
          return yield* Effect.fail(new CrewHandoffError("Handoff is not waiting for an answer"));
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const moved = yield* handoffs.transition(
          id,
          ["needs-input"],
          "running",
          now,
          {
            responseText: value,
          },
          true,
        );
        if (!moved) return yield* Effect.fail(new CrewHandoffError("Handoff changed concurrently"));
        const updated = (yield* handoffs.get(id))!;
        yield* deliver(updated).pipe(Effect.result);
        yield* changed(updated);
        return (yield* handoffs.get(id))!;
      },
    );

    const settleIfExited = Effect.fn("CrewHandoffService.settleIfExited")(function* (
      handoff: CrewHandoff,
    ) {
      // The answer turn may not have reached its recipient yet. The previous
      // completed turn does not settle the newly resumed handoff.
      if (handoff.notificationState === "queued") return;
      const view = yield* crew.getRun(handoff.targetRunId);
      if (!view || !["completed", "failed", "interrupted"].includes(view.status)) return;
      // A recipient that ended its turn while its own handoffs work is waiting: their
      // notices wake it to respond, so it need not wait to stay alive.
      if (view.status === "completed") {
        const delegated = yield* handoffs.listBySourceRun(handoff.targetRunId);
        const waiting = delegated.some(
          (child) =>
            child.status === "queued" ||
            child.status === "running" ||
            child.notificationState === "queued",
        );
        if (waiting) return;
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const detail =
        view.status === "completed"
          ? "Recipient ended without a structured crew_respond outcome"
          : `Recipient run ${view.status}`;
      const moved = yield* handoffs.transition(
        handoff.id,
        ["running"],
        "failed",
        now,
        { lastError: detail, responseText: detail },
        true,
      );
      if (!moved) return;
      yield* changed(handoff);
      yield* startWaiting().pipe(Effect.result);
    });

    const cancel = Effect.fn("CrewHandoffService.cancel")(function* (id: string) {
      const handoff = yield* handoffs.get(id);
      if (!handoff) return yield* Effect.fail(new CrewHandoffError("Handoff not found"));
      if (handoff.status === "cancelled") return handoff;
      if (handoff.status === "completed") {
        return yield* Effect.fail(new CrewHandoffError("Completed handoff cannot be cancelled"));
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const target = yield* runs.getRun(handoff.targetRunId);
      if (target && ["running", "pending"].includes(yield* runtime.getTurnState(target.threadId))) {
        yield* runtime.interrupt(target.threadId, id, now);
      }
      yield* handoffs.transition(id, [handoff.status], "cancelled", now, undefined, true);
      const updated = (yield* handoffs.get(id))!;
      yield* deliver(updated).pipe(Effect.result);
      yield* changed(updated);
      yield* startWaiting().pipe(Effect.result);
      return (yield* handoffs.get(id))!;
    });

    const retry = Effect.fn("CrewHandoffService.retry")(function* (id: string) {
      const handoff = yield* handoffs.get(id);
      if (!handoff) return yield* Effect.fail(new CrewHandoffError("Handoff not found"));
      if (handoff.status === "queued" || handoff.status === "running") return handoff;
      if (handoff.status !== "failed" && handoff.status !== "cancelled") {
        return yield* Effect.fail(
          new CrewHandoffError("Only failed or cancelled handoffs can retry"),
        );
      }
      const sourceRun = yield* runs.getRun(handoff.sourceRunId);
      const sourceMember = sourceRun ? yield* runs.getActor(sourceRun.memberId) : null;
      const targetMember = yield* runs.getMember(handoff.targetMemberId);
      if (
        !sourceRun ||
        !sourceMember?.enabled ||
        !targetMember?.enabled ||
        !(yield* runs.canDelegate(sourceMember.id, targetMember.id, handoff.projectId))
      ) {
        return yield* Effect.fail(new CrewHandoffError("Delegation permission is unavailable"));
      }
      const previous = yield* runs.getRun(handoff.targetRunId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const moved = yield* handoffs.retry(id, now);
      if (!moved) return yield* Effect.fail(new CrewHandoffError("Handoff retry is unavailable"));
      const started = yield* startQueued((yield* handoffs.get(id))!);
      // The retry runs in a new thread; it joins the work its first attempt was on.
      if (previous) yield* tagThread(started, previous.threadId);
      return started;
    });

    const refreshProject = Effect.fn("CrewHandoffService.refreshProject")(function* (
      projectId: ProjectId,
    ) {
      const running = yield* handoffs.listRunningByProject(projectId);
      yield* Effect.forEach(running, settleIfExited, { concurrency: 1, discard: true });
      const notifications = yield* handoffs.listUndeliveredByProject(projectId);
      yield* Effect.forEach(notifications, (handoff) => deliver(handoff).pipe(Effect.result), {
        concurrency: 1,
        discard: true,
      });
    });

    return {
      delegate,
      respond: (threadId, outcome, summary) =>
        updateFromRecipient(threadId, "crew.respond", outcome, summary),
      ask: (threadId, question) =>
        updateFromRecipient(threadId, "crew.ask", "needs-input", question),
      answer,
      answerFromBot: Effect.fn("CrewHandoffService.answerFromBot")(
        function* (threadId, id, answerText) {
          const run = yield* requireRun(threadId, "crew.answer");
          const handoff = yield* handoffs.get(id);
          if (handoff?.sourceRunId !== run.id) {
            return yield* Effect.fail(new CrewHandoffError("Handoff is unavailable to this run"));
          }
          return yield* answer(id, answerText);
        },
      ),
      cancel,
      retry,
      actInProject: Effect.fn("CrewHandoffService.actInProject")(function* ({
        projectId,
        requestId,
        action,
        text,
      }) {
        const handoff = yield* handoffs.get(requestId);
        if (handoff?.projectId !== projectId) {
          return yield* Effect.fail(new CrewHandoffError("Handoff not found in project"));
        }
        if (action === "answer") {
          if (!text) return yield* Effect.fail(new CrewHandoffError("Answer is required"));
          return yield* answer(requestId, text);
        }
        return yield* action === "cancel" ? cancel(requestId) : retry(requestId);
      }),
      projectSnapshot: Effect.fn("CrewHandoffService.projectSnapshot")(function* (projectId) {
        if (!(yield* runtime.projectExists(projectId))) {
          return yield* Effect.fail(new CrewHandoffError("Project not found"));
        }
        yield* refreshProject(projectId);
        const [members, runSummaries, recent] = yield* Effect.all([
          runs.listMembersForProject(projectId),
          crew.listRunSummaries(projectId, 50),
          handoffs.listByProject(projectId, 100),
        ]);
        return { members, runs: runSummaries, handoffs: recent };
      }),
      get: handoffs.get,
      listByRun: handoffs.listBySourceRun,
      reconcile: Effect.fn("CrewHandoffService.reconcile")(function* () {
        const pending = yield* handoffs.listPending();
        yield* Effect.forEach(pending, (handoff) => startQueued(handoff).pipe(Effect.result), {
          concurrency: 1,
          discard: true,
        });
        const running = yield* handoffs.listRunning();
        yield* Effect.forEach(running, settleIfExited, { concurrency: 1, discard: true });
        const notifications = yield* handoffs.listUndelivered();
        yield* Effect.forEach(notifications, (handoff) => deliver(handoff).pipe(Effect.result), {
          concurrency: 1,
          discard: true,
        });
      }),
      refreshProject,
      refreshRun: Effect.fn("CrewHandoffService.refreshRun")(function* (runId) {
        const handoff = yield* handoffs.getForTargetRun(runId);
        if (handoff?.status === "running") yield* settleIfExited(handoff);
        const updated = handoff ? yield* handoffs.get(handoff.id) : null;
        if (updated) yield* deliver(updated).pipe(Effect.result);
      }),
    } satisfies CrewHandoffServiceShape;
  }),
);
