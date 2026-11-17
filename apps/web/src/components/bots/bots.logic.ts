import { projectBotId } from "@t3tools/client-runtime/state/bot-rail";
import type { BotTransferMode, BotTransferResult, EnvironmentId } from "@t3tools/contracts";

/** The given projects grouped by the bot that owns them (null: no bot), keeping their order. */
export function groupProjectsByBot<Project extends { readonly botId?: string | null | undefined }>(
  projects: ReadonlyArray<Project>,
): ReadonlyMap<string | null, ReadonlyArray<Project>> {
  const groups = new Map<string | null, Project[]>();
  for (const project of projects) {
    const botId = projectBotId(project);
    const group = groups.get(botId);
    if (group) group.push(project);
    else groups.set(botId, [project]);
  }
  return groups;
}

/** The full rail order with `botId` moved to `targetId`'s place, or null when nothing moves. */
export function moveBotTo(
  botIds: ReadonlyArray<string>,
  botId: string,
  targetId: string,
): string[] | null {
  const from = botIds.indexOf(botId);
  const to = botIds.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...botIds];
  next.splice(from, 1);
  next.splice(to, 0, botId);
  return next;
}

/** The full rail order with `botId` moved by `offset`, or null when it can't move that way. */
export function moveBotInOrder(
  botIds: ReadonlyArray<string>,
  botId: string,
  offset: -1 | 1,
): string[] | null {
  const target = botIds[botIds.indexOf(botId) + offset];
  return botIds.includes(botId) && target !== undefined ? moveBotTo(botIds, botId, target) : null;
}

/** Why a bot can't be deleted yet, matching the server's rule; null when it can. */
export function botDeleteBlocker(ownedProjects: number): string | null {
  if (ownedProjects > 0)
    return `Unlink its ${ownedProjects === 1 ? "project" : `${ownedProjects} projects`} first.`;
  return null;
}

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/**
 * What a transfer does with the bot's automations other than webhooks, which the preview lists
 * one by one; null when there are none of those.
 */
export function botTransferAutomationsLine(
  mode: BotTransferMode,
  automations: BotTransferResult["automations"],
  targetLabel: string,
): string | null {
  const total = automations.copied - automations.needAttention.length;
  if (total <= 0) return null;
  if (mode === "copy") {
    return `${count(total, "arrives", "arrive")} turned off. Turn ${total === 1 ? "it" : "them"} on on ${targetLabel} when you're ready.`;
  }
  const off = total - automations.enabled;
  if (off === 0) return count(total, "goes along and stays on.", "go along and stay on.");
  if (automations.enabled === 0) return `${count(total, "goes along", "go along")}, turned off.`;
  return `${count(total, "goes along", "go along")}. ${count(automations.enabled, "stays on", "stay on")}, ${count(off, "stays off", "stay off")}.`;
}

/** A move's projects left with no bot, by machine, each listed once. */
export function botTransferLeftOut(projects: BotTransferResult["projects"]) {
  const machines = new Map<
    EnvironmentId,
    {
      environmentId: EnvironmentId;
      label: string;
      projects: Array<BotTransferResult["projects"][number]>;
    }
  >();
  for (const project of projects) {
    if (project.outcome !== "left-without-bot") continue;
    const machine = machines.get(project.environmentId) ?? {
      environmentId: project.environmentId,
      label: project.environmentLabel,
      projects: [],
    };
    machine.projects.push(project);
    machines.set(project.environmentId, machine);
  }
  return {
    count: [...machines.values()].reduce((sum, machine) => sum + machine.projects.length, 0),
    machines: [...machines.values()],
  };
}
