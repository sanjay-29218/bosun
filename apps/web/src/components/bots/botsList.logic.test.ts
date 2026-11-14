import { buildLogicalBots } from "@t3tools/client-runtime/state/bot-rail";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { botProjectsLabel, botsListManagers, managerSubtitle } from "./botsList.logic";

const local = EnvironmentId.make("local");
const plain = EnvironmentId.make("plain");
const avatar = {
  head: "round",
  eyes: "round",
  face: "visor",
  top: "ball",
  cheeks: false,
  smile: false,
} as const;
const bots = buildLogicalBots([
  {
    environmentId: local,
    bots: [
      { id: "bot-ops", name: "Ops", avatar, color: "blue", position: 0 },
      { id: "bot-idle", name: "Idle", avatar, color: "blue", position: 1, pinned: false },
    ],
  },
]);
const project = (
  id: string,
  title: string,
  extra: {
    readonly botId?: string | null;
    readonly managerPinned?: boolean;
    readonly isScratch?: true;
    readonly isBotHome?: true;
    readonly environmentId?: EnvironmentId;
  } = {},
) => ({ environmentId: local, id: ProjectId.make(id), title, ...extra });
const projects = [
  project("web", "web", { botId: "bot-ops", managerPinned: true }),
  project("api", "api", { botId: "bot-ops" }),
  project("notes", "Notes", { botId: null, managerPinned: false }),
  project("scratch", "Scratch", { isScratch: true }),
  project("home", "Ops", { botId: "bot-ops", isBotHome: true }),
  project("old", "old", { environmentId: plain }),
];

describe("botsListManagers", () => {
  it("lists every project's manager by title, leaving out Scratch, homes and plain servers", () => {
    const managers = botsListManagers({
      projects,
      bots,
      managerEnvironmentIds: new Set([local]),
      projectKeyOf: (_environmentId, projectId) => `key:${projectId}`,
    });
    expect(managers.map((manager) => [manager.title, manager.ownerKey, manager.pinned])).toEqual([
      ["api", "name:ops", true],
      ["Notes", null, false],
      ["web", "name:ops", true],
    ]);
  });
});

describe("botProjectsLabel", () => {
  it("counts the projects a bot owns, without its home", () => {
    expect(botProjectsLabel(bots[0]!, bots, projects)).toBe("2 projects");
    expect(botProjectsLabel(bots[1]!, bots, projects)).toBe("No projects");
  });
});

describe("managerSubtitle", () => {
  it("names the owner, or No bot, and the environment when there are several", () => {
    expect(managerSubtitle("Ops", null)).toBe("Ops");
    expect(managerSubtitle(null, "Laptop")).toBe("No bot · Laptop");
  });
});
