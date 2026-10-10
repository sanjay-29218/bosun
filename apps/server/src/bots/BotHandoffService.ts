import { type ModelSelection, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";

import { BotService, type BotServiceError } from "./BotService.ts";
import { BotStore, type BotRun } from "./BotStore.ts";
import { BotHandoffStore, type BotHandoff } from "./BotHandoffStore.ts";
import { BotThreadRuntime } from "./BotThreadRuntime.ts";

export class BotHandoffError extends Error {
  readonly _tag = "BotHandoffError";
}

export interface DelegateBotInput {
  readonly id: string;
  readonly sourceThreadId: ThreadId;
  readonly targetBotId: string;
  readonly projectId: ProjectId;
  readonly taskText: string;
  readonly contextText?: string;
  /** Runs the target bot on another model, as Retry with another model does. */
  readonly modelSelection?: ModelSelection;
}

export interface BotHandoffServiceShape {
  readonly delegate: (
    input: DelegateBotInput,
  ) => Effect.Effect<BotHandoff, BotServiceError | BotHandoffError>;
  readonly respond: (
    threadId: ThreadId,
    outcome: "completed" | "failed",
    summary: string,
  ) => Effect.Effect<BotHandoff, BotHandoffError | BotServiceError>;
  readonly ask: (
    threadId: ThreadId,
    question: string,
  ) => Effect.Effect<BotHandoff, BotHandoffError | BotServiceError>;
  readonly answer: (
    id: string,
    answer: string,
  ) => Effect.Effect<BotHandoff, BotHandoffError | BotServiceError>;
  readonly answerFromBot: (
    threadId: ThreadId,
    id: string,
    answer: string,
  ) => Effect.Effect<BotHandoff, BotHandoffError | BotServiceError>;
  readonly cancel: (id: string) => Effect.Effect<BotHandoff, BotHandoffError | BotServiceError>;
  readonly retry: (id: string) => Effect.Effect<BotHandoff, BotHandoffError | BotServiceError>;
  readonly get: (id: string) => Effect.Effect<BotHandoff | null, BotServiceError>;
  readonly listByRun: (runId: string) => Effect.Effect<ReadonlyArray<BotHandoff>, BotServiceError>;
  readonly waitFor: (
    threadId: ThreadId,
    id: string,
  ) => Effect.Effect<BotHandoff, BotHandoffError | BotServiceError>;
  readonly reconcile: () => Effect.Effect<void, BotServiceError>;
  readonly refreshProject: (projectId: ProjectId) => Effect.Effect<void, BotServiceError>;
  readonly refreshRun: (runId: string) => Effect.Effect<void, BotServiceError>;
}

export class BotHandoffService extends Context.Service<BotHandoffService, BotHandoffServiceShape>()(
  "t3/bots/BotHandoffService",
) {}

const bounded = (value: string, name: string, max: number) => {
  const text = value.trim();
  if (text.length === 0 || text.length > max) {
    throw new BotHandoffError(`${name} must contain 1-${max} characters`);
  }
  return text;
};

const sameRequest = (handoff: BotHandoff, input: DelegateBotInput, sourceRunId: string) =>
  handoff.sourceRunId === sourceRunId &&
  handoff.targetBotId === input.targetBotId &&
  handoff.projectId === input.projectId &&
  handoff.taskText === input.taskText.trim() &&
  handoff.contextText === (input.contextText?.trim() ?? "") &&
  JSON.stringify(handoff.modelSelection ?? null) === JSON.stringify(input.modelSelection ?? null);

export const BotHandoffServiceLive = Layer.effect(
  BotHandoffService,
  Effect.gen(function* () {
    const handoffs = yield* BotHandoffStore;
    const runs = yield* BotStore;
    const bots = yield* BotService;
    const runtime = yield* BotThreadRuntime;
    const changes = yield* PubSub.unbounded<string>();

    const deliver = (handoff: BotHandoff) =>
      Effect.gen(function* () {
        if (handoff.notificationState !== "queued") return;
        const recipientRunId =
          handoff.status === "running" ? handoff.targetRunId : handoff.sourceRunId;
        const recipient = yield* runs.getRun(recipientRunId);
        if (!recipient) return;
        const prompt =
          handoff.status === "running"
            ? `Bot answer for handoff ${handoff.id}: ${handoff.responseText ?? ""}`
            : handoff.status === "needs-input"
              ? `Bot handoff ${handoff.id} needs input from you: ${handoff.questionText ?? ""}`
              : `Bot handoff ${handoff.id} is ${handoff.status}. ${handoff.responseText ?? ""}`;
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

    const requireRun = (threadId: ThreadId, grant: string) =>
      Effect.gen(function* () {
        const runId = yield* handoffs.getRunByThread(threadId);
        const run = runId ? yield* runs.getRun(runId) : null;
        if (!run || !run.allowedTools.includes(grant)) {
          return yield* Effect.fail(new BotHandoffError(`This thread cannot use ${grant}`));
        }
        return run;
      });

    const requireIncoming = (run: BotRun) =>
      handoffs
        .getForTargetRun(run.id)
        .pipe(
          Effect.flatMap((handoff) =>
            handoff
              ? Effect.succeed(handoff)
              : Effect.fail(new BotHandoffError("This run has no incoming handoff")),
          ),
        );

    const startQueued = (handoff: BotHandoff) =>
      Effect.gen(function* () {
        if (handoff.status !== "queued") return handoff;
        const sourceRun = yield* runs.getRun(handoff.sourceRunId);
        const sourceBot = sourceRun ? yield* runs.getDefinition(sourceRun.botId) : null;
        const targetBot = yield* runs.getDefinition(handoff.targetBotId);
        if (
          !sourceBot?.enabled ||
          !targetBot?.enabled ||
          !(yield* runs.canDelegate(sourceBot.id, targetBot.id))
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
        yield* bots.createRun({
          id: handoff.targetRunId,
          botId: handoff.targetBotId,
          projectId: handoff.projectId,
          taskText: `${handoff.taskText}${handoff.contextText ? `\n\nContext:\n${handoff.contextText}` : ""}`,
          ...(handoff.modelSelection ? { modelSelection: handoff.modelSelection } : {}),
        });
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* handoffs.transition(handoff.id, ["queued"], "running", now);
        return (yield* handoffs.get(handoff.id))!;
      });

    const delegate: BotHandoffServiceShape["delegate"] = (input) =>
      Effect.gen(function* () {
        const id = yield* Effect.try({
          try: () => bounded(input.id, "Request ID", 128),
          catch: () => new BotHandoffError("Invalid request ID"),
        });
        const taskText = yield* Effect.try({
          try: () => bounded(input.taskText, "Task", 8_000),
          catch: () => new BotHandoffError("Invalid task"),
        });
        const contextText = input.contextText?.trim() ?? "";
        if (contextText.length > 4_000) {
          return yield* Effect.fail(new BotHandoffError("Context exceeds 4,000 characters"));
        }
        const source = yield* requireRun(input.sourceThreadId, "bots.delegate");
        if (source.projectId !== input.projectId) {
          return yield* Effect.fail(new BotHandoffError("Source run belongs to another project"));
        }
        const existing = yield* handoffs.get(id);
        if (existing) {
          if (!sameRequest(existing, { ...input, taskText, contextText }, source.id)) {
            return yield* Effect.fail(new BotHandoffError("Request ID belongs to another handoff"));
          }
          return yield* startQueued(existing);
        }
        const sourceBot = yield* runs.getDefinition(source.botId);
        const targetBot = yield* runs.getDefinition(input.targetBotId);
        if (!sourceBot || !targetBot?.enabled || targetBot.projectId !== input.projectId) {
          return yield* Effect.fail(
            new BotHandoffError("Target bot is unavailable for this project"),
          );
        }
        if (!(yield* runs.canDelegate(sourceBot.id, targetBot.id))) {
          return yield* Effect.fail(new BotHandoffError("Delegation is not permitted"));
        }
        const parent = yield* handoffs.getForTargetRun(source.id);
        const depth = (parent?.depth ?? 0) + 1;
        if (depth > 8) {
          return yield* Effect.fail(new BotHandoffError("Delegation depth exceeded"));
        }
        if (parent) {
          const ancestors = yield* handoffs.listAncestors(parent.id);
          if (ancestors.some((ancestor) => ancestor.targetBotId === targetBot.id)) {
            return yield* Effect.fail(new BotHandoffError("Delegation cycle rejected"));
          }
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const handoff: BotHandoff = {
          id,
          parentId: parent?.id ?? null,
          sourceRunId: source.id,
          targetBotId: targetBot.id,
          targetRunId: `bot-handoff:${id}`,
          projectId: input.projectId,
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
        if (!persisted || !sameRequest(persisted, { ...input, taskText, contextText }, source.id)) {
          return yield* Effect.fail(new BotHandoffError("Request ID belongs to another handoff"));
        }
        return yield* startQueued(persisted);
      });

    const updateFromRecipient = (
      threadId: ThreadId,
      grant: "bots.respond" | "bots.ask",
      status: "completed" | "failed" | "needs-input",
      text: string,
    ) =>
      Effect.gen(function* () {
        const value = yield* Effect.try({
          try: () => bounded(text, status === "needs-input" ? "Question" : "Summary", 8_000),
          catch: () => new BotHandoffError("Invalid response text"),
        });
        const run = yield* requireRun(threadId, grant);
        const handoff = yield* requireIncoming(run);
        if (handoff.status === status && (handoff.responseText ?? handoff.questionText) === value) {
          return handoff;
        }
        if (handoff.status !== "running") {
          return yield* Effect.fail(new BotHandoffError("Handoff is not running"));
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
        if (!changed)
          return yield* Effect.fail(new BotHandoffError("Handoff changed concurrently"));
        const updated = (yield* handoffs.get(handoff.id))!;
        yield* PubSub.publish(changes, updated.id);
        yield* deliver(updated).pipe(Effect.result);
        return (yield* handoffs.get(handoff.id))!;
      });

    const answer: BotHandoffServiceShape["answer"] = (id, answerText) =>
      Effect.gen(function* () {
        const value = yield* Effect.try({
          try: () => bounded(answerText, "Answer", 8_000),
          catch: () => new BotHandoffError("Invalid answer"),
        });
        const current = yield* handoffs.get(id);
        if (current?.status === "running" && current.responseText === value) return current;
        const recipient = current ? yield* runs.getRun(current.targetRunId) : null;
        if (!recipient) return yield* Effect.fail(new BotHandoffError("Recipient run not found"));
        const handoff = yield* requireIncoming(recipient);
        if (handoff.status !== "needs-input") {
          return yield* Effect.fail(new BotHandoffError("Handoff is not waiting for an answer"));
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
          return yield* Effect.fail(new BotHandoffError("Handoff changed concurrently"));
        const updated = (yield* handoffs.get(id))!;
        yield* PubSub.publish(changes, id);
        yield* deliver(updated).pipe(Effect.result);
        return (yield* handoffs.get(id))!;
      });

    const settleIfExited = (handoff: BotHandoff) =>
      Effect.gen(function* () {
        // The answer turn may not have reached its recipient yet. The previous
        // completed turn does not settle the newly resumed handoff.
        if (handoff.notificationState === "queued") return;
        const view = yield* bots.getRun(handoff.targetRunId);
        if (!view || !["completed", "failed", "interrupted"].includes(view.status)) return;
        const now = DateTime.formatIso(yield* DateTime.now);
        const detail =
          view.status === "completed"
            ? "Recipient ended without a structured bots_respond outcome"
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

    return {
      delegate,
      respond: (threadId, outcome, summary) =>
        updateFromRecipient(threadId, "bots.respond", outcome, summary),
      ask: (threadId, question) =>
        updateFromRecipient(threadId, "bots.ask", "needs-input", question),
      answer,
      answerFromBot: (threadId, id, answerText) =>
        Effect.gen(function* () {
          const run = yield* requireRun(threadId, "bots.answer");
          const handoff = yield* handoffs.get(id);
          if (handoff?.sourceRunId !== run.id) {
            return yield* Effect.fail(new BotHandoffError("Handoff is unavailable to this run"));
          }
          return yield* answer(id, answerText);
        }),
      cancel: (id) =>
        Effect.gen(function* () {
          const handoff = yield* handoffs.get(id);
          if (!handoff) return yield* Effect.fail(new BotHandoffError("Handoff not found"));
          if (handoff.status === "cancelled") return handoff;
          if (handoff.status === "completed") {
            return yield* Effect.fail(new BotHandoffError("Completed handoff cannot be cancelled"));
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const target = yield* runs.getRun(handoff.targetRunId);
          if (
            target &&
            ["running", "pending"].includes(yield* runtime.getTurnState(target.threadId))
          ) {
            yield* runtime.interrupt(target.threadId, id, now);
          }
          yield* handoffs.transition(id, [handoff.status], "cancelled", now, undefined, true);
          const updated = (yield* handoffs.get(id))!;
          yield* PubSub.publish(changes, id);
          yield* deliver(updated).pipe(Effect.result);
          return (yield* handoffs.get(id))!;
        }),
      retry: (id) =>
        Effect.gen(function* () {
          const handoff = yield* handoffs.get(id);
          if (!handoff) return yield* Effect.fail(new BotHandoffError("Handoff not found"));
          if (handoff.status === "queued" || handoff.status === "running") return handoff;
          if (handoff.status !== "failed" && handoff.status !== "cancelled") {
            return yield* Effect.fail(
              new BotHandoffError("Only failed or cancelled handoffs can retry"),
            );
          }
          const sourceRun = yield* runs.getRun(handoff.sourceRunId);
          const sourceBot = sourceRun ? yield* runs.getDefinition(sourceRun.botId) : null;
          const targetBot = yield* runs.getDefinition(handoff.targetBotId);
          if (
            !sourceBot?.enabled ||
            !targetBot?.enabled ||
            !(yield* runs.canDelegate(sourceBot.id, targetBot.id))
          ) {
            return yield* Effect.fail(new BotHandoffError("Delegation permission is unavailable"));
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const changed = yield* handoffs.retry(id, now);
          if (!changed)
            return yield* Effect.fail(new BotHandoffError("Handoff retry is unavailable"));
          return yield* startQueued((yield* handoffs.get(id))!);
        }),
      get: handoffs.get,
      listByRun: handoffs.listBySourceRun,
      waitFor: (threadId, id) =>
        Effect.scoped(
          Effect.gen(function* () {
            const run = yield* requireRun(threadId, "bots.status");
            const subscription = yield* PubSub.subscribe(changes);
            const read = () =>
              handoffs
                .get(id)
                .pipe(
                  Effect.flatMap((handoff) =>
                    handoff?.sourceRunId === run.id
                      ? Effect.succeed(handoff)
                      : Effect.fail(new BotHandoffError("Handoff is unavailable to this run")),
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
      reconcile: () =>
        Effect.gen(function* () {
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
      refreshProject: (projectId) =>
        Effect.gen(function* () {
          const running = yield* handoffs.listRunningByProject(projectId);
          yield* Effect.forEach(running, settleIfExited, { concurrency: 1, discard: true });
          const notifications = yield* handoffs.listUndeliveredByProject(projectId);
          yield* Effect.forEach(notifications, (handoff) => deliver(handoff).pipe(Effect.result), {
            concurrency: 1,
            discard: true,
          });
        }),
      refreshRun: (runId) =>
        Effect.gen(function* () {
          const handoff = yield* handoffs.getForTargetRun(runId);
          if (handoff?.status === "running") yield* settleIfExited(handoff);
          const updated = handoff ? yield* handoffs.get(handoff.id) : null;
          if (updated) yield* deliver(updated).pipe(Effect.result);
        }),
    } satisfies BotHandoffServiceShape;
  }),
);
