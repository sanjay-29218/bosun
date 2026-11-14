import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import {
  botHeadquartersThreadId,
  EnvironmentId,
  ProjectId,
  projectHeadquartersThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  followStandingThread,
  standingFollowAction,
  standingThreadSelection,
} from "./standingThreadSelection";

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

describe("standingFollowAction", () => {
  it("leaves the rail for the Bots list's own navigation, and follows every other one", () => {
    expect(standingFollowAction({ key: "env:a", followedKey: null, leaveRail: true })).toBe(
      "leave",
    );
    // The next navigation carries no intent of its own, so the rail follows it.
    expect(standingFollowAction({ key: "env:b", followedKey: "env:a", leaveRail: false })).toBe(
      "follow",
    );
    expect(standingFollowAction({ key: "env:b", followedKey: "env:b", leaveRail: false })).toBe(
      "none",
    );
  });

  it("follows an open after a cancelled one, since the cancelled navigation left nothing behind", () => {
    // An unsaved-editor guard cancels the Bots list's navigation: the route never lands on
    // env:a with `leaveRail`. A later open of env:a from the palette is followed.
    expect(standingFollowAction({ key: "env:a", followedKey: null, leaveRail: false })).toBe(
      "follow",
    );
  });
});
