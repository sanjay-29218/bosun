import type { OrchestrationMessageContext } from "@t3tools/contracts";

/**
 * Crew turns use T3's user-message transport; this durable context identifies the crew member
 * that sent them. Persisted records keep their original "bot" kind and `botId` payload key.
 */
export const crewMessageOrigin = (context: OrchestrationMessageContext | undefined) => {
  const record = context?.records.find(
    (entry) => entry.kind === "bot" || entry.kind === "bosun-bot",
  );
  if (!record || (record.kind !== "bot" && record.kind !== "bosun-bot")) return null;
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const fields = payload as Record<string, unknown>;
  const memberId = fields.memberId ?? fields.botId;
  return typeof memberId === "string" && typeof fields.runId === "string"
    ? { memberId, runId: fields.runId }
    : null;
};

/** Crew run threads keep the persisted "bot-run:" id prefix. */
export const isCrewThreadId = (threadId: string) =>
  threadId.startsWith("bot-run:") || threadId.startsWith("bosun-run:");
