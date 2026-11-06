// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/;

/**
 * The folder a bot's home is in, under the bots folder. An ID that is a safe lowercase folder
 * name on every filesystem is used as is; any other gets "@" and a hash, which no such name
 * contains, so no two IDs share a home even where names compare case-insensitively.
 */
export function botHomeFolderName(botId: string): string {
  if (
    /^[a-z0-9_-][a-z0-9._-]*$/.test(botId) &&
    !botId.endsWith(".") &&
    !WINDOWS_RESERVED_NAME.test(botId)
  ) {
    return botId;
  }
  const hash = NodeCrypto.createHash("sha256").update(botId).digest("hex").slice(0, 16);
  const readable = botId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, 64);
  return `${readable}@${hash}`;
}
