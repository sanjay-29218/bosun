import { ProjectIconColor, type ProjectManagerIcon } from "@t3tools/contracts";

import { BOT_AVATAR_PRESETS } from "./botAvatar.ts";

// FNV-1a: a stable spread from a short id, the same on every client.
const hashId = (id: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** A project manager's look: the one chosen for it, else one derived from its project id. */
export function projectManagerLook(
  projectId: string,
  icon: ProjectManagerIcon | null | undefined,
): ProjectManagerIcon {
  if (icon) return icon;
  const hash = hashId(projectId);
  const colors = ProjectIconColor.literals;
  return {
    avatar: BOT_AVATAR_PRESETS[hash % BOT_AVATAR_PRESETS.length]!,
    // Divided first so the avatar and color vary independently.
    color: colors[Math.floor(hash / BOT_AVATAR_PRESETS.length) % colors.length]!,
  };
}
