import {
  botHeadquartersThreadId,
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  type BotAvatar,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botActivityByBot,
  botActivityByLogicalBot,
  botRailShowsThread,
  botListEnvironmentIds,
  botListSubtitle,
  botRailSignal,
  buildConnectedLogicalBots,
  buildLogicalBots,
  countHiddenNeedsYou,
  pinnedProjectManagers,
  railProjectKeys,
  writePins,
  countNeedsYouByLogicalBot,
  logicalBotsSignature,
  logicalBotHeadquartersKeys,
  logicalBotHome,
  logicalBotProjectKeys,
  logicalBotProjectLists,
  projectBotId,
  resolveActiveLogicalBot,
  resolveEnvironmentFilter,
  selectLogicalBot,
} from "./botRail.ts";
import { botNeedsYouKey } from "./crewBoard.ts";

const CAPTAIN_ID = "bot-ops";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

const avatar = (eyes: BotAvatar["eyes"]): BotAvatar => ({
  head: "round",
  eyes,
  face: "visor",
  top: "ball",
  cheeks: false,
  smile: false,
});
const bot = (id: string, name: string, position: number, eyes: BotAvatar["eyes"] = "round") => ({
  id,
  name,
  avatar: avatar(eyes),
  color: "blue" as const,
  position,
});

const environments = [
  {
    environmentId: local,
    bots: [bot("bot-social", "Social", 1, "happy"), bot(CAPTAIN_ID, "Captain", 0, "star")],
  },
  {
    environmentId: remote,
    bots: [
      bot(CAPTAIN_ID, " captain", 0, "visor"),
      bot("bot-finance", "Finance", 1),
      bot("bot-social-2", " social ", 2),
    ],
  },
];

describe("projectBotId", () => {
  it("reads a project without an owner as having no bot", () => {
    expect(projectBotId({})).toBeNull();
    expect(projectBotId({ botId: null })).toBeNull();
    expect(projectBotId({ botId: "bot-social" })).toBe("bot-social");
  });
});

describe("buildLogicalBots", () => {
  it("keeps every bot its own entry, same-named ones too, in priority then rail order", () => {
    const bots = buildLogicalBots(environments);
    expect(bots.map((entry) => [entry.key, entry.name, entry.avatar.eyes])).toEqual([
      [`id:local:${CAPTAIN_ID}`, "Captain", "star"],
      ["id:local:bot-social", "Social", "happy"],
      [`id:remote:${CAPTAIN_ID}`, " captain", "visor"],
      ["id:remote:bot-finance", "Finance", "round"],
      ["id:remote:bot-social-2", " social ", "round"],
    ]);
    expect(bots[1]!.members).toEqual([{ environmentId: local, botId: "bot-social", pinned: true }]);
  });
});

describe("bot lists across machines", () => {
  it("reads connected bot environments first, then known ones that are offline", () => {
    const vps = EnvironmentId.make("vps");
    const plain = EnvironmentId.make("plain");
    expect(
      botListEnvironmentIds({
        botEnvironmentIds: [local, remote],
        knownEnvironmentIds: [local, vps, remote, plain],
        connectedEnvironmentIds: [remote, plain],
      }),
    ).toEqual([remote, local, vps]);
  });

  it("names the machine when several are known, and Offline when it can't be reached", () => {
    expect(botListSubtitle({ machine: null, online: true, projects: "2 projects" })).toBe(
      "2 projects",
    );
    expect(botListSubtitle({ machine: "VPS", online: true, projects: "No projects" })).toBe(
      "VPS · No projects",
    );
    expect(botListSubtitle({ machine: "VPS", online: false, projects: "2 projects" })).toBe(
      "VPS · Offline",
    );
    expect(botListSubtitle({ machine: null, online: false, projects: "2 projects" })).toBe(
      "Offline",
    );
  });
});

describe("pins", () => {
  it("reads each bot's own pin, and older servers as pinned", () => {
    const bots = buildLogicalBots([
      { environmentId: local, bots: [{ ...bot("bot-a", "Social", 0), pinned: false }] },
      { environmentId: remote, bots: [bot("bot-b", "Social", 0), bot("bot-c", "Finance", 1)] },
      {
        environmentId: EnvironmentId.make("other"),
        bots: [{ ...bot("bot-d", "Ops", 0), pinned: false }],
      },
    ]);
    expect(bots.map((entry) => [entry.name, entry.pinned])).toEqual([
      ["Social", false],
      ["Social", true],
      ["Finance", true],
      ["Ops", false],
    ]);
  });

  it("tells lists apart when only one environment's pin changed", () => {
    // Another client unpinned the bot on remote; local's same-named bot stays pinned.
    const before = buildLogicalBots([
      { environmentId: local, bots: [bot("bot-a", "Social", 0)] },
      { environmentId: remote, bots: [bot("bot-b", "Social", 0)] },
    ]);
    const after = buildLogicalBots([
      { environmentId: local, bots: [bot("bot-a", "Social", 0)] },
      { environmentId: remote, bots: [{ ...bot("bot-b", "Social", 0), pinned: false }] },
    ]);
    expect(after.map((entry) => entry.pinned)).toEqual([true, false]);
    expect(logicalBotsSignature(after)).not.toBe(logicalBotsSignature(before));
  });

  it("counts threads waiting on you that only an unpinned bot or manager shows", () => {
    const bots = buildLogicalBots([
      {
        environmentId: local,
        bots: [bot("bot-shown", "Shown", 0), { ...bot("bot-hidden", "Hidden", 1), pinned: false }],
      },
    ]);
    const project = (id: string, botId: string | null, managerPinned?: boolean) => ({
      environmentId: local,
      id: ProjectId.make(id),
      botId,
      ...(managerPinned === undefined ? {} : { managerPinned }),
    });
    const shell = (id: string, projectId: string) => ({
      environmentId: local,
      id,
      projectId: ProjectId.make(projectId),
    });
    const projects = [
      project("shown", "bot-shown", true),
      project("hidden", "bot-hidden", true),
      project("quiet", "bot-shown", false),
      project("loose", null),
    ];
    expect(
      countHiddenNeedsYou({
        bots,
        projects,
        shells: [
          shell("a", "shown"),
          // Under an unpinned bot.
          shell("b", "hidden"),
          shell(botHeadquartersThreadId("bot-hidden"), "scratch"),
          // An unpinned manager's own thread, though its bot is pinned.
          shell("bot-run:project-hq:quiet", "quiet"),
          // A pinned manager, and a project with no bot, show in the rail.
          shell("bot-run:project-hq:shown", "shown"),
          // A pinned manager shows even when its bot isn't pinned.
          shell("bot-run:project-hq:hidden", "hidden"),
          shell("c", "loose"),
        ],
      }),
    ).toBe(3);
  });
});

describe("railProjectKeys", () => {
  const all = buildLogicalBots([
    {
      environmentId: local,
      bots: [
        bot("bot-a", "A", 0),
        bot("bot-b", "B", 1),
        { ...bot("bot-idle", "Idle", 2), pinned: false },
      ],
    },
  ]);
  const pinned = all.filter((entry) => entry.pinned);
  const projects = [
    { environmentId: local, id: "a", botId: "bot-a" },
    { environmentId: local, id: "idle", botId: "bot-idle" },
    { environmentId: local, id: "loose", botId: null },
  ];

  it("keeps an unpinned bot's projects its own, and shows its machine's no-bot projects", () => {
    expect([
      ...railProjectKeys({
        active: pinned[0]!,
        pinnedBots: pinned,
        allBots: all,
        projects,
        botEnvironmentIds: new Set([local]),
        environmentFilter: null,
      })!,
    ]).toEqual(["local:a", "local:loose"]);
  });

  it("shows a project the list is scoped to even when its bot isn't pinned", () => {
    // Picking the pinned manager of Idle's project keeps the rail on A and scopes to it.
    const keys = railProjectKeys({
      active: pinned[0]!,
      pinnedBots: pinned,
      allBots: all,
      projects,
      botEnvironmentIds: new Set([local]),
      environmentFilter: null,
      scopedProjects: [{ environmentId: local, id: "idle" }],
    });
    expect([...keys!]).toEqual(["local:a", "local:loose", "local:idle"]);
  });

  it("doesn't scope with fewer than two pinned bots", () => {
    expect(
      railProjectKeys({
        active: pinned[0]!,
        pinnedBots: pinned.slice(0, 1),
        allBots: all,
        projects,
        botEnvironmentIds: new Set([local]),
        environmentFilter: null,
      }),
    ).toBeNull();
  });
});

describe("pinnedProjectManagers", () => {
  it("lists pinned managers by title, threads or not, leaving out what has no manager", () => {
    const project = (id: string, title: string, extra: object = {}) => ({
      environmentId: local,
      id: ProjectId.make(id),
      title,
      managerPinned: true,
      ...extra,
    });
    const managers = pinnedProjectManagers({
      projects: [
        project("web", "web"),
        project("api", "api"),
        project("quiet", "quiet", { managerPinned: false }),
        project("off", "off"),
        project("scratch", "Scratch", { isScratch: true }),
        project("home", "Ops", { isBotHome: true }),
        { ...project("plain", "plain"), environmentId: remote },
      ],
      managerEnvironmentIds: new Set([local]),
      archivedManagers: new Set([`${local}:off`]),
    });
    expect(managers.map((manager) => manager.id)).toEqual(["api", "web"]);
  });
});

describe("writePins", () => {
  it("puts back the targets that were written when another fails", async () => {
    const writes: Array<[string, boolean]> = [];
    const failure = await writePins(
      [
        { id: "a", previous: false },
        { id: "b", previous: true },
        { id: "c", previous: false },
      ],
      true,
      async (target, pinned) => {
        writes.push([target.id, pinned]);
        return target.id === "c" && pinned ? "offline" : null;
      },
    );
    expect(failure).toBe("offline");
    // b was already pinned, so only a goes back.
    expect(writes).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
      ["a", false],
    ]);
  });

  it("writes nothing back when every target succeeds", async () => {
    const writes: string[] = [];
    expect(
      await writePins([{ id: "a", previous: true }], false, async (target) => {
        writes.push(target.id);
        return null;
      }),
    ).toBeNull();
    expect(writes).toEqual(["a"]);
  });
});

describe("buildLogicalBots with a repeated name", () => {
  it("keeps a second same-named bot on one environment as its own entry", () => {
    const bots = buildLogicalBots([
      { environmentId: local, bots: [bot("bot-a", "Social", 0), bot("bot-b", "social", 1)] },
    ]);
    expect(bots.map((entry) => entry.members.map((member) => member.botId))).toEqual([
      ["bot-a"],
      ["bot-b"],
    ]);
    expect(
      logicalBotProjectKeys(
        bots[1]!,
        bots,
        [{ environmentId: local, id: "p", botId: "bot-b" }],
        new Set([local]),
      ),
    ).toEqual(new Set(["local:p"]));
  });
});

describe("resolveActiveLogicalBot", () => {
  const bots = buildLogicalBots(environments);

  it("follows the first environment whose remembered bot still exists", () => {
    expect(
      resolveActiveLogicalBot(bots, { local: "bot-gone", remote: "bot-finance" }, [local, remote])
        ?.name,
    ).toBe("Finance");
  });

  it("selects the first bot when nothing remembered is still listed", () => {
    expect(resolveActiveLogicalBot(bots, {}, [local, remote])?.name).toBe("Captain");
    expect(resolveActiveLogicalBot(bots, { local: "bot-gone" }, [local, remote])?.name).toBe(
      "Captain",
    );
    expect(resolveActiveLogicalBot([], {}, [local])).toBeNull();
  });

  it("remembers the bot on its environment", () => {
    const next = selectLogicalBot(bots[1]!);
    expect(next).toEqual({ local: "bot-social" });
    expect(resolveActiveLogicalBot(bots, next, [local, remote])?.name).toBe("Social");
  });

  it("ignores a remembered bot whose machine is offline, though its list was kept", () => {
    // After a reload `local` is offline with its kept list; its remembered bot isn't active.
    const live = buildConnectedLogicalBots(environments, [remote]);
    expect(live.every((entry) => entry.members[0]!.environmentId === remote)).toBe(true);
    expect(
      resolveActiveLogicalBot(live, { local: "bot-social", remote: "bot-finance" }, [local, remote])
        ?.key,
    ).toBe("id:remote:bot-finance");
  });

  it("selects a bot that only a later environment has", () => {
    const finance = bots.find((entry) => entry.name === "Finance")!;
    const next = selectLogicalBot(finance);
    expect(resolveActiveLogicalBot(bots, next, [local, remote])?.name).toBe("Finance");
  });
});

describe("logicalBotProjectKeys", () => {
  const bots = buildLogicalBots(environments);
  const projects = [
    { environmentId: local, id: "a", botId: "bot-social" },
    { environmentId: remote, id: "b", botId: "bot-social-2" },
    { environmentId: remote, id: "c" },
    // An owner the rail hasn't loaded yet: no entry shows it until it loads.
    { environmentId: local, id: "d", botId: "bot-unknown" },
  ];

  const withBots = new Set([local, remote]);

  it("selects the projects each entry owns, and its machine's projects with no bot", () => {
    expect([...logicalBotProjectKeys(bots[1]!, bots, projects, withBots)]).toEqual(["local:a"]);
    // The same-named bot on remote is another entry, with its own project.
    expect([...logicalBotProjectKeys(bots[4]!, bots, projects, withBots)]).toEqual([
      "remote:b",
      "remote:c",
    ]);
    expect([...logicalBotProjectKeys(bots[2]!, bots, projects, withBots)]).toEqual(["remote:c"]);
    expect([...logicalBotProjectKeys(bots[0]!, bots, projects, withBots)]).toEqual([]);
  });

  it("never lists another machine's project under an unrelated bot, owner set or not", () => {
    const vps = EnvironmentId.make("vps");
    const linked = [
      { environmentId: vps, id: "omni" },
      { environmentId: vps, id: "owned-there", botId: "bot-vps" },
      { environmentId: remote, id: "loose", botId: null },
      {
        environmentId: remote,
        id: "given",
        botId: null,
        remoteBot: { environmentId: vps, botId: "bot-vps", name: "Ops", homeLabel: "VPS" },
      },
    ];
    const localBots = bots.filter((candidate) => logicalBotHome(candidate) === local);
    // The VPS runs Bosun, but the rail lists none of its bots: an older Bosun, or still loading.
    const vpsRunsBots = new Set([local, remote, vps]);
    for (const entry of localBots) {
      expect([...logicalBotProjectKeys(entry, bots, linked, vpsRunsBots)]).toEqual([]);
    }
    // A bot that may work on remote shows remote's projects with no bot, which it can take.
    const permitted = { ...bots[1]!, permittedEnvironmentIds: [remote] };
    expect([...logicalBotProjectKeys(permitted, bots, linked, vpsRunsBots)]).toEqual([
      "remote:loose",
    ]);
    // A T3 Code server has no bot to show its projects, so every bot does.
    for (const entry of localBots) {
      expect([...logicalBotProjectKeys(entry, bots, linked, withBots)]).toEqual(["vps:omni"]);
    }
  });

  it("splits an entry's projects into owned, takeable, not allowed, and without bots", () => {
    const vps = EnvironmentId.make("vps");
    const withVps = [...projects, { environmentId: vps, id: "omni" }];
    const social = bots[1]!;
    const lists = logicalBotProjectLists(social, bots, withVps, new Set([local, remote]));
    expect(lists.owned.map((project) => project.id)).toEqual(["a"]);
    expect(lists.available.map((project) => project.id)).toEqual(["d"]);
    // Social may not work on the remote environment until it is ticked there.
    expect(lists.notAllowed.map((project) => project.id)).toEqual(["b", "c"]);
    expect(lists.withoutBots.map((project) => project.id)).toEqual(["omni"]);

    const permitted = { ...social, permittedEnvironmentIds: [remote] };
    const given = [
      ...withVps,
      // Given to Social from its home: owned without a copy of Social there.
      {
        environmentId: remote,
        id: "e",
        botId: null,
        remoteBot: {
          environmentId: local,
          botId: "bot-social",
          name: "Social",
          homeLabel: "Laptop",
        },
      },
    ];
    const reach = logicalBotProjectLists(permitted, bots, given, new Set([local, remote]));
    expect(reach.owned.map((project) => project.id)).toEqual(["a", "e"]);
    expect(reach.available.map((project) => project.id)).toEqual(["b", "c", "d"]);
    expect(reach.notAllowed).toEqual([]);
  });
});

describe("countNeedsYouByLogicalBot", () => {
  it("counts each bot's own threads", () => {
    const bots = buildLogicalBots(environments);
    const counts = countNeedsYouByLogicalBot(
      bots,
      new Map([
        [botNeedsYouKey(local, "bot-social"), 2],
        [botNeedsYouKey(remote, "bot-social-2"), 1],
        [botNeedsYouKey(remote, CAPTAIN_ID), 4],
        [botNeedsYouKey(local, "bot-unknown"), 5],
      ]),
    );
    expect(counts.get(bots[1]!.key)).toBe(2);
    expect(counts.get(bots[4]!.key)).toBe(1);
    expect(counts.get(bots[2]!.key)).toBe(4);
    expect(counts.get(bots[0]!.key)).toBeUndefined();
  });
});

describe("resolveEnvironmentFilter", () => {
  it("narrows to connected selected environments", () => {
    expect(resolveEnvironmentFilter(null, [local, remote])).toBeNull();
    expect([...resolveEnvironmentFilter(["remote"], [local, remote])!]).toEqual([remote]);
  });

  it("reads as all when nothing selected is connected, or everything is", () => {
    expect(resolveEnvironmentFilter(["gone"], [local, remote])).toBeNull();
    expect(resolveEnvironmentFilter([], [local])).toBeNull();
    expect(resolveEnvironmentFilter(["local", "remote"], [local, remote])).toBeNull();
  });
});

describe("botRailShowsThread", () => {
  it("shows a bot's own headquarters under it, whatever project holds it", () => {
    const [captain, social] = buildLogicalBots([
      {
        environmentId: local,
        bots: [bot(CAPTAIN_ID, "Captain", 0), bot("bot-social", "Social", 1)],
      },
    ]);
    const thread = (id: string, projectId: string) => ({ environmentId: local, id, projectId });
    const socialProjects = new Set([`${local}:p-social`]);
    const socialHeadquarters = logicalBotHeadquartersKeys(social!);
    const show = (target: ReturnType<typeof thread>) =>
      botRailShowsThread(target, socialProjects, socialHeadquarters);

    // Headquarters sit in Scratch, a project neither bot's filter lists.
    expect(show(thread(botHeadquartersThreadId("bot-social"), "scratch"))).toBe(true);
    expect(show(thread(botHeadquartersThreadId(CAPTAIN_ID), "scratch"))).toBe(false);
    expect(show(thread("plain", "p-social"))).toBe(true);
    expect(show(thread("plain", "p-captain"))).toBe(false);
    // A hidden environment's headquarters stays hidden.
    const [shared] = buildLogicalBots([
      { environmentId: local, bots: [bot(CAPTAIN_ID, "Captain", 0)] },
      { environmentId: remote, bots: [bot(CAPTAIN_ID, "Captain", 0)] },
    ]);
    expect([...logicalBotHeadquartersKeys(shared!, new Set([local]))]).toEqual([
      `${local}:${botHeadquartersThreadId(CAPTAIN_ID)}`,
    ]);
    // Without a picked bot, project keys alone decide.
    expect(
      botRailShowsThread(
        thread(botHeadquartersThreadId(captain!.members[0]!.botId), "s"),
        null,
        null,
      ),
    ).toBe(true);
  });
});

describe("bot activity", () => {
  const [captain, social] = buildLogicalBots([
    {
      environmentId: local,
      bots: [bot(CAPTAIN_ID, "Captain", 0), bot("bot-social", "Social", 1)],
    },
  ]);
  const projects = [
    { environmentId: local, id: ProjectId.make("p-captain"), botId: CAPTAIN_ID },
    { environmentId: local, id: ProjectId.make("p-loose") },
    { environmentId: local, id: ProjectId.make("p-social"), botId: "bot-social" },
  ];
  const runId = RunId.make("run-1");
  const shell = (
    id: string,
    projectId: string,
    run: { status: "running" | "completed" | "failed"; completedAt: string | null } | null,
    lastVisitedAt: string | null | undefined,
  ) => ({
    environmentId: local,
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    archivedAt: null,
    lastVisitedAt,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    interactionMode: "default" as const,
    latestRun:
      run === null
        ? null
        : {
            runId,
            status: run.status,
            requestedAt: null,
            startedAt: null,
            completedAt: run.completedAt,
            assistantMessageId: null,
          },
    runtime:
      run?.status === "running"
        ? {
            status: "running" as const,
            activeRunId: runId,
            providerInstanceId: "codex" as never,
            providerName: null,
            lastError: null,
            updatedAt: "2026-10-01T00:00:00.000Z",
          }
        : null,
  });
  const before = "2026-10-01T00:00:00.000Z";
  const after = "2026-10-01T01:00:00.000Z";

  it("flags failed, working and unread threads under their bot", () => {
    const activity = botActivityByBot(
      [
        shell("failed", "p-social", { status: "failed", completedAt: after }, before),
        shell("working", "p-captain", { status: "running", completedAt: null }, before),
        shell("done", "p-captain", { status: "completed", completedAt: after }, before),
        // A project with no bot is no bot's activity.
        shell("loose", "p-loose", { status: "running", completedAt: null }, before),
        // Opened since it finished: nothing to flag.
        shell("seen", "p-social", { status: "completed", completedAt: before }, after),
      ],
      projects,
    );
    // A failed run is also an unread one; the signal shows the failure.
    expect(activity.get(botNeedsYouKey(local, "bot-social"))).toEqual({
      failed: true,
      working: false,
      unread: true,
    });
    expect(activity.get(botNeedsYouKey(local, CAPTAIN_ID))).toEqual({
      failed: false,
      working: true,
      unread: true,
    });
  });

  it("counts a headquarters under its own bot, and nothing from servers without visits", () => {
    const activity = botActivityByBot(
      [
        shell(
          botHeadquartersThreadId("bot-social"),
          "scratch",
          { status: "completed", completedAt: after },
          before,
        ),
        shell("old-server", "p-captain", { status: "failed", completedAt: after }, undefined),
      ],
      projects,
    );
    expect([...activity.keys()]).toEqual([botNeedsYouKey(local, "bot-social")]);
  });

  it("merges per rail entry", () => {
    const perEntry = botActivityByLogicalBot(
      [captain!, social!],
      new Map([
        [botNeedsYouKey(local, "bot-social"), { failed: false, working: true, unread: false }],
        [botNeedsYouKey(local, "bot-unknown"), { failed: false, working: false, unread: true }],
      ]),
    );
    // A bot the rail doesn't know counts for no entry.
    expect(perEntry.get(captain!.key)).toBeUndefined();
    expect(perEntry.get(social!.key)).toEqual({ failed: false, working: true, unread: false });
  });

  it("shows one signal, the most urgent", () => {
    const everything = { failed: true, working: true, unread: true };
    expect(botRailSignal(2, everything)).toEqual({ kind: "needs-you", count: 2 });
    expect(botRailSignal(0, everything)).toEqual({ kind: "failed" });
    expect(botRailSignal(0, { ...everything, failed: false })).toEqual({ kind: "working" });
    expect(botRailSignal(0, { failed: false, working: false, unread: true })).toEqual({
      kind: "unread",
    });
    expect(botRailSignal(0, undefined)).toBeNull();
  });
});
