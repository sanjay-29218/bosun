import type { OrchestrationMessageContext } from "@t3tools/contracts";

/** Bot turns use T3's user-message transport; this durable context identifies their actual actor. */
export const botMessageOrigin = (context: OrchestrationMessageContext | undefined) => {
  const record = context?.records.find(
    (entry) => entry.kind === "bot" || entry.kind === "bosun-bot",
  );
  if (!record || (record.kind !== "bot" && record.kind !== "bosun-bot")) return null;
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const fields = payload as Record<string, unknown>;
  return typeof fields.botId === "string" && typeof fields.runId === "string"
    ? { botId: fields.botId, runId: fields.runId }
    : null;
};

export const isBotThreadId = (threadId: string) =>
  threadId.startsWith("bot-run:") || threadId.startsWith("bosun-run:");
