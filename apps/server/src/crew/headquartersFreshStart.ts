import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * A headquarters follows every request its bot gets, so its provider conversation only grows.
 * Past this size it starts a fresh one, briefed with the bot's instructions and latest messages.
 */
export const FRESH_START_TOKENS = 100_000;
/** How long a headquarters set to start fresh waits without a new turn before it does. */
export const FRESH_START_QUIET_MINUTES = 30;
const RECENT_MESSAGES = 4;
const RECENT_MESSAGE_CHARS = 1_500;

export type FreshStartRecords = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "runtimeRequests" | "providerThreads" | "providerTurns" | "messages"
>;

const BUSY_RUN_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);

/** No turn runs or waits, and nothing asks for an answer: a fresh start loses nothing in flight. */
export function headquartersIdle({
  runs,
  runtimeRequests,
}: Pick<FreshStartRecords, "runs" | "runtimeRequests">): boolean {
  return (
    !runs.some((run) => BUSY_RUN_STATUSES.has(run.status)) &&
    !runtimeRequests.some((request) => request.status === "pending")
  );
}

/** Whether the headquarters should start fresh now that `runId` completed. */
export function freshStartDue(records: FreshStartRecords, runId: RunId): boolean {
  const { thread, runs, providerThreads, providerTurns } = records;
  if (thread.deletedAt !== null || thread.archivedAt !== null) return false;
  const latestRun = runs.reduce<(typeof runs)[number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  if (latestRun?.id !== runId || latestRun.status !== "completed") return false;
  if (!headquartersIdle(records)) return false;
  const providerThread = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  if (providerThread === undefined || providerThread.id !== latestRun.providerThreadId)
    return false;
  const latestUsage = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  return (latestUsage?.usedTokens ?? 0) >= FRESH_START_TOKENS;
}

const clip = (text: string) =>
  text.length <= RECENT_MESSAGE_CHARS ? text : `${text.slice(0, RECENT_MESSAGE_CHARS - 3)}...`;

/**
 * The fresh conversation's first message. It leads with the fresh-session note, which is what the
 * thread shows of it, then the headquarters' own opening prompt and the last few messages so a
 * reply to the latest question still lands.
 */
export function freshStartBriefing(
  prompt: string,
  messages: FreshStartRecords["messages"],
): string {
  const recent = messages
    .filter((message) => message.role !== "system" && message.text.trim().length > 0)
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
    )
    .slice(-RECENT_MESSAGES)
    .map(
      (message) =>
        `${message.role === "assistant" ? "You" : "To you"}: ${clip(message.text.trim())}`,
    );
  return [
    "This is a fresh session. The person still sees the earlier conversation, but you no longer have it. Look up current work with t3_project_list and task_status before you answer about it.",
    prompt,
    ...(recent.length === 0 ? [] : [`The latest messages:\n\n${recent.join("\n\n")}`]),
  ].join("\n\n");
}
