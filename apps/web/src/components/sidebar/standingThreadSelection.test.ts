import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import {
  botHeadquartersThreadId,
  EnvironmentId,
  ProjectId,
  projectHeadquartersThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { standingThreadSelection } from "./standingThreadSelection";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const bot = (key: string, botId: string): LogicalBot => ({
  key,
  name: key,
  avatar: { head: "round", face: "flat", eyes: "dash", top: "none", cheeks: false, smile: false },
  color: "blue",
  members: [{ environmentId: local, botId }],
});
const captain = bot("id:bot-captain", "bot-captain");
const navigator = bot("name:navigator", "bot-navigator");
const scout = bot("name:scout", "bot-scout");
const bots = [captain, navigator, scout];
const alpha = ProjectId.make("project-alpha");
const beta = ProjectId.make("project-beta");
const projects = [
  { environmentId: local, id: alpha },
  { environmentId: local, id: beta, botId: "bot-scout" },
];
const projectKeyOf = (_environmentId: EnvironmentId, projectId: ProjectId) =>
  projectId === alpha
    ? "github.com/acme/alpha"
    : projectId === beta
      ? "github.com/acme/beta"
      : null;
const decide = (threadId: ThreadId, environmentId = local, input = { bots, projects }) =>
  standingThreadSelection({ environmentId, threadId, projectKeyOf, ...input });

describe("standingThreadSelection", () => {
  it("picks the bot whose headquarters is open, without a project scope", () => {
    expect(decide(botHeadquartersThreadId("bot-captain"))).toEqual({
      kind: "select",
      botKey: captain.key,
      projectKey: null,
    });
  });

  it("picks a manager's owning bot and scopes the list to its project", () => {
    expect(decide(projectHeadquartersThreadId(beta))).toEqual({
      kind: "select",
      botKey: scout.key,
      projectKey: "github.com/acme/beta",
    });
    // A project without a bot is Captain's.
    expect(decide(projectHeadquartersThreadId(alpha))).toEqual({
      kind: "select",
      botKey: captain.key,
      projectKey: "github.com/acme/alpha",
    });
  });

  it("waits while the thread's bot or project hasn't loaded", () => {
    expect(decide(botHeadquartersThreadId("bot-captain"), remote)).toEqual({ kind: "pending" });
    expect(decide(projectHeadquartersThreadId(alpha), local, { bots: [], projects })).toEqual({
      kind: "pending",
    });
    expect(decide(projectHeadquartersThreadId(beta), local, { bots, projects: [] })).toEqual({
      kind: "pending",
    });
  });

  it("leaves the rail alone for any other thread", () => {
    expect(decide(ThreadId.make("thread-1"))).toEqual({ kind: "none" });
  });
});
