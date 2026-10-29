import { EnvironmentId } from "@t3tools/contracts";

/** What the Bots page shows: a bot on an environment, or a new one. */
export interface BotsSearch {
  readonly environmentId?: EnvironmentId;
  readonly botId?: string;
  /** A new bot, on `environmentId` when given. */
  readonly new?: true;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function validateBotsSearch(raw: Record<string, unknown>): BotsSearch {
  return {
    ...(nonEmpty(raw.environmentId)
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(nonEmpty(raw.botId) ? { botId: raw.botId } : raw.new === true ? { new: true } : {}),
  };
}
