import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import {
  botHeadquartersThreadId,
  EnvironmentId,
  ProjectId,
  projectHeadquartersThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { followStandingThread, standingThreadSelection } from "./standingThreadSelection";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const bot = (key: string, botId: string): LogicalBot => ({
  key,
  name: key,
  avatar: { head: "round", face: "flat", eyes: "dash", top: "none", cheeks: false, smile: false },
  color: "blue",
  pinned: true,
  members: [{ environmentId: local, botId }],
});
const captain = bot("name:captain", "bot-ops");
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
    expect(decide(botHeadquartersThreadId("bot-ops"))).toEqual({
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
    // A project with no bot shows under every bot, so the picked bot stays.
    expect(decide(projectHeadquartersThreadId(alpha))).toEqual({
      kind: "select",
      botKey: null,
      projectKey: "github.com/acme/alpha",
    });
  });

  it("waits while the thread's bot or project hasn't loaded", () => {
    expect(decide(botHeadquartersThreadId("bot-ops"), remote)).toEqual({ kind: "pending" });
    expect(decide(projectHeadquartersThreadId(beta), local, { bots: [], projects })).toEqual({
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

describe("followStandingThread", () => {
  const alphaKey = "github.com/acme/alpha";

  it("clears a project scope when the current bot's headquarters opens", () => {
    expect(
      followStandingThread(
        { activeBotKey: captain.key, scopeKeys: [alphaKey] },
        { botKey: captain.key, projectKey: null },
      ),
    ).toEqual({ selectBot: false, scopeKeys: [] });
  });

  it("scopes to a manager's project, picking its bot when another is picked", () => {
    expect(
      followStandingThread(
        { activeBotKey: navigator.key, scopeKeys: [] },
        { botKey: captain.key, projectKey: alphaKey },
      ),
    ).toEqual({ selectBot: true, scopeKeys: [alphaKey] });
  });

  it("keeps the picked bot for a manager of a project with no bot", () => {
    expect(
      followStandingThread(
        { activeBotKey: navigator.key, scopeKeys: [] },
        { botKey: null, projectKey: alphaKey },
      ),
    ).toEqual({ selectBot: false, scopeKeys: [alphaKey] });
  });

  it("restores a matching scope that picking another bot would clear", () => {
    expect(
      followStandingThread(
        { activeBotKey: navigator.key, scopeKeys: [alphaKey] },
        { botKey: captain.key, projectKey: alphaKey },
      ),
    ).toEqual({ selectBot: true, scopeKeys: [alphaKey] });
  });

  it("changes nothing that already matches", () => {
    expect(
      followStandingThread(
        { activeBotKey: captain.key, scopeKeys: [alphaKey] },
        { botKey: captain.key, projectKey: alphaKey },
      ),
    ).toEqual({ selectBot: false, scopeKeys: null });
    expect(
      followStandingThread(
        { activeBotKey: captain.key, scopeKeys: [] },
        { botKey: captain.key, projectKey: null },
      ),
    ).toEqual({ selectBot: false, scopeKeys: null });
  });
});

describe("an unpinned bot", () => {
  // A and B are pinned, C isn't, and B is the bot in use.
  const idle: LogicalBot = { ...bot("name:idle", "bot-idle"), pinned: false };
  const gamma = ProjectId.make("project-gamma");
  const withIdle = {
    bots: [captain, navigator, idle],
    projects: [...projects, { environmentId: local, id: gamma, botId: "bot-idle" }],
  };
  const keyOf = (_environmentId: EnvironmentId, projectId: ProjectId) =>
    projectId === gamma ? "github.com/acme/gamma" : projectKeyOf(_environmentId, projectId);
  const open = (threadId: ThreadId) =>
    standingThreadSelection({ environmentId: local, threadId, projectKeyOf: keyOf, ...withIdle });

  it("keeps the bot in use and scopes to the project when its pinned manager opens", () => {
    const selection = open(projectHeadquartersThreadId(gamma));
    expect(selection).toEqual({
      kind: "select",
      botKey: null,
      projectKey: "github.com/acme/gamma",
    });
    expect(
      followStandingThread(
        { activeBotKey: navigator.key, scopeKeys: [] },
        selection as Extract<typeof selection, { kind: "select" }>,
      ),
    ).toEqual({ selectBot: false, scopeKeys: ["github.com/acme/gamma"] });
  });

  it("leaves the rail where it is when its headquarters opens", () => {
    expect(open(botHeadquartersThreadId("bot-idle"))).toEqual({ kind: "none" });
  });
});
