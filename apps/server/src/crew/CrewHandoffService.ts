import {
  headquartersBotId,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";

import * as BotStore from "../bots/BotStore.ts";
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
  /** The requests the calling thread's run delegated, for runs granted crew.status. */
  readonly listForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<CrewHandoff>, CrewHandoffError | CrewServiceError>;
  readonly get: (id: string) => Effect.Effect<CrewHandoff | null, CrewServiceError>;
  readonly listByRun: (
    runId: string,
  ) => Effect.Effect<ReadonlyArray<CrewHandoff>, CrewServiceError>;
  readonly waitFor: (
    threadId: ThreadId,
    id: string,
  ) => Effect.Effect<CrewHandoff, CrewHandoffError | CrewServiceError>;
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
    const changes = yield* PubSub.unbounded<string>();

    const deliver = Effect.fn("CrewHandoffService.deliver")(function* (handoff: CrewHandoff) {
      if (handoff.notificationState !== "queued") return;
      const recipientRunId =
        handoff.status === "running" ? handoff.targetRunId : handoff.sourceRunId;
      const recipient = yield* runs.getRun(recipientRunId);
      if (!recipient) return;
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

    const startQueued = Effect.fn("CrewHandoffService.startQueued")(function* (
      handoff: CrewHandoff,
    ) {
      if (handoff.status !== "queued") return handoff;
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
        yield* PubSub.publish(changes, updated.id);
        yield* deliver(updated).pipe(Effect.result);
        return updated;
      }
      yield* crew.createRun({
        id: handoff.targetRunId,
        memberId: handoff.targetMemberId,
        projectId: handoff.projectId,
        taskText: `${handoff.taskText}${handoff.contextText ? `\n\nContext:\n${handoff.contextText}` : ""}`,
        ...(handoff.modelSelection ? { modelSelection: handoff.modelSelection } : {}),
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* handoffs.transition(handoff.id, ["queued"], "running", now);
      return (yield* handoffs.get(handoff.id))!;
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
        const source = yield* requireRun(input.sourceThreadId, "crew.delegate");
        const existing = yield* handoffs.get(id);
        if (existing) {
          if (!sameRequest(existing, { ...input, taskText, contextText }, source)) {
            return yield* Effect.fail(
              new CrewHandoffError("Request ID belongs to another handoff"),
            );
          }
          return yield* startQueued(existing);
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
        const parent = yield* handoffs.getForTargetRun(source.id);
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
        return yield* startQueued(persisted);
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
      const changed = yield* handoffs.transition(
        handoff.id,
        ["running"],
        status,
        now,
        status === "needs-input" ? { questionText: value } : { responseText: value },
        true,
      );
      if (!changed) return yield* Effect.fail(new CrewHandoffError("Handoff changed concurrently"));
      const updated = (yield* handoffs.get(handoff.id))!;
      yield* PubSub.publish(changes, updated.id);
      yield* deliver(updated).pipe(Effect.result);
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
        const changed = yield* handoffs.transition(
          id,
          ["needs-input"],
          "running",
          now,
          {
            responseText: value,
          },
          true,
        );
        if (!changed)
          return yield* Effect.fail(new CrewHandoffError("Handoff changed concurrently"));
        const updated = (yield* handoffs.get(id))!;
        yield* PubSub.publish(changes, id);
        yield* deliver(updated).pipe(Effect.result);
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
      const now = DateTime.formatIso(yield* DateTime.now);
      const detail =
        view.status === "completed"
          ? "Recipient ended without a structured crew_respond outcome"
          : `Recipient run ${view.status}`;
      const changed = yield* handoffs.transition(
        handoff.id,
        ["running"],
        "failed",
        now,
        { lastError: detail, responseText: detail },
        true,
      );
      if (changed) yield* PubSub.publish(changes, handoff.id);
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
      yield* PubSub.publish(changes, id);
      yield* deliver(updated).pipe(Effect.result);
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
      const now = DateTime.formatIso(yield* DateTime.now);
      const changed = yield* handoffs.retry(id, now);
      if (!changed) return yield* Effect.fail(new CrewHandoffError("Handoff retry is unavailable"));
      return yield* startQueued((yield* handoffs.get(id))!);
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
      listForThread: (threadId) =>
        requireRun(threadId, "crew.status").pipe(
          Effect.flatMap((run) => handoffs.listBySourceRun(run.id)),
        ),
      get: handoffs.get,
      listByRun: handoffs.listBySourceRun,
      waitFor: (threadId, id) =>
        Effect.scoped(
          Effect.gen(function* () {
            const run = yield* requireRun(threadId, "crew.status");
            const subscription = yield* PubSub.subscribe(changes);
            const read = () =>
              handoffs.get(id).pipe(
                Effect.filterOrFail(
                  (handoff): handoff is NonNullable<typeof handoff> =>
                    handoff?.sourceRunId === run.id,
                  () => new CrewHandoffError("Handoff is unavailable to this run"),
                ),
              );
            let handoff = yield* read();
            if (handoff.status !== "queued" && handoff.status !== "running") return handoff;
            while (true) {
              const changedId = yield* PubSub.take(subscription).pipe(
                Effect.timeoutOption("30 seconds"),
              );
              if (Option.isNone(changedId)) return yield* read();
              if (changedId.value !== id) continue;
              handoff = yield* read();
              if (handoff.status !== "queued" && handoff.status !== "running") return handoff;
            }
          }),
        ),
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
