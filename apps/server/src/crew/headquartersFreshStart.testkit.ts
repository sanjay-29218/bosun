import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { FRESH_START_TOKENS, type FreshStartRecords } from "./headquartersFreshStart.ts";

export const at = (minutes: number) =>
  DateTime.makeUnsafe(Date.parse("2026-10-30T12:00:00.000Z") + minutes * 60_000);
export const threadId = ThreadId.make("bot-run:bot-hq:bot-captain");
export const runId = RunId.make("run-1");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread");
const modelSelection = { instanceId, model: "claude-opus-5-5" };
export const nodeId = NodeId.make("root-node");

/** A headquarters whose latest turn, `runId`, completed with `usedTokens` in its conversation. */
export function freshStartRecords(usedTokens = FRESH_START_TOKENS): {
  -readonly [Key in keyof FreshStartRecords]: FreshStartRecords[Key];
} {
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId,
    userMessageId: MessageId.make("message-1"),
    rootNodeId: nodeId,
    activeAttemptId: null,
    status: "completed" as const,
    requestedAt: at(-1),
    startedAt: at(-1),
    completedAt: at(0),
    checkpointId: null,
    contextHandoffId: null,
  };
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Captain",
      createdBy: "agent",
      creationSource: "mcp",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-10),
      updatedAt: at(0),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(0),
      deletedAt: null,
    },
    runs: [run],
    messages: [],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: at(-10),
        updatedAt: at(0),
      },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("provider-turn-1"),
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-1),
        completedAt: at(0),
        tokenUsage: { usedTokens, updatedAt: DateTime.formatIso(at(0)) },
      },
    ],
    runtimeRequests: [],
  };
}
