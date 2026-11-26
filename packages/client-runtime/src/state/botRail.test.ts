import {
  botHeadquartersThreadId,
  EnvironmentId,
  projectHeadquartersThreadId,
  ProjectId,
  RunId,
  ThreadId,
  type BotAvatar,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botActivityByBot,
  botActivityByLogicalBot,
  activityByProject,
  activityForProjects,
  listRowThreadKeys,
  needsYouForProjects,
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
  logicalBotProjectKeys,
  railBotsSettled,
  resolveSidebarLayout,
  logicalBotProjectLists,
  projectBotId,
  resolveActiveLogicalBot,
  resolveEnvironmentFilter,
  selectLogicalBot,
} from "./botRail.ts";
import { botNeedsYouKey } from "./crewBoard.ts";
import { threadKey } from "./entities.ts";

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

  it("counts asks an unpinned bot or manager shows and no pinned one does", () => {
    const bots = buildLogicalBots([
      {
        environmentId: local,
        bots: [bot("bot-shown", "Shown", 0), { ...bot("bot-hidden", "Hidden", 1), pinned: false }],
      },
    ]);
    const project = (
      id: string,
      botId: string | null,
      extra: { readonly managerPinned?: boolean; readonly isScratch?: true } = {},
    ) => ({ environmentId: local, id: ProjectId.make(id), title: id, botId, ...extra });
    const shell = (id: string, projectId: string) => ({
      environmentId: local,
      id,
      projectId: ProjectId.make(projectId),
    });
    const projects = [
      project("shown", "bot-shown"),
      project("hidden", "bot-hidden"),
      project("unmanaged", "bot-hidden", { managerPinned: false }),
      project("quiet", "bot-shown", { managerPinned: false }),
      // Scratch has no manager, and here no bot: nothing lists its chats as an entry.
      project("loose", null, { isScratch: true }),
      project("loose-unpinned", null, { managerPinned: false }),
      project("loose-managed", null),
    ];
    // The projects pinned managers show, by `${environmentId}:${projectId}`.
    const managedProjectKeys = new Set(
      ["shown", "hidden", "loose-managed"].map((id) => `${local}:${id}`),
    );
    expect(
      countHiddenNeedsYou({
        bots,
        projects,
        managedProjectKeys,
        managerEnvironmentIds: new Set([local]),
        shells: [
          shell("a", "shown"),
          // An unpinned bot's project, but its pinned manager shows it.
          shell("b", "hidden"),
          // An unpinned bot's project whose manager isn't pinned.
          shell("d", "unmanaged"),
          shell(botHeadquartersThreadId("bot-hidden"), "scratch"),
          shell(botHeadquartersThreadId("bot-shown"), "scratch"),
          // An unpinned manager under a pinned bot: only its own thread is hidden.
          shell("bot-run:project-hq:quiet", "quiet"),
          shell("g", "quiet"),
          shell("bot-run:project-hq:shown", "shown"),
          shell("bot-run:project-hq:hidden", "hidden"),
          shell("c", "loose"),
          // A project with no bot shows only on its manager.
          shell("f", "loose-unpinned"),
          shell("e", "loose-managed"),
        ],
      }),
    ).toBe(4);
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

  it("shows only the projects the picked bot owns, never an unpinned bot's or an unowned one", () => {
    expect([
      ...railProjectKeys({ active: pinned[0]!, allBots: all, projects, environmentFilter: null })!,
    ]).toEqual(["local:a"]);
  });

  it("shows no project for a bot that owns none, even when it's the only one pinned", () => {
    expect([
      ...railProjectKeys({ active: pinned[1]!, allBots: all, projects, environmentFilter: null })!,
    ]).toEqual([]);
    expect([
      ...railProjectKeys({
        active: pinned[0]!,
        allBots: [pinned[0]!],
        projects,
        environmentFilter: null,
      })!,
    ]).toEqual(["local:a"]);
  });

  it("shows a project the list is scoped to even when its bot isn't pinned", () => {
    // Picking the pinned manager of Idle's project keeps the rail on A and scopes to it.
    const keys = railProjectKeys({
      active: pinned[0]!,
      allBots: all,
      projects,
      environmentFilter: null,
      scopedProjects: [{ environmentId: local, id: "idle" }],
    });
    expect([...keys!]).toEqual(["local:a", "local:idle"]);
  });

  it("narrows only by environment with Projects picked", () => {
    expect(
      railProjectKeys({ active: null, allBots: all, projects, environmentFilter: null }),
    ).toBeNull();
    expect([
      ...railProjectKeys({
        active: null,
        allBots: all,
        projects: [...projects, { environmentId: remote, id: "far", botId: null }],
        environmentFilter: new Set([remote]),
      })!,
    ]).toEqual(["remote:far"]);
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
        // This copy's manager lives on another machine; that machine lists it.
        project("web-copy", "web", {
          remoteManager: {
            environmentId: remote,
            projectId: ProjectId.make("web"),
            homeLabel: "Box",
          },
        }),
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
      logicalBotProjectKeys(bots[1]!, bots, [{ environmentId: local, id: "p", botId: "bot-b" }]),
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

describe("railBotsSettled", () => {
  const answered = { connection: "connected", configured: true, bots: "loaded" } as const;
  const loading = { connection: "connected", configured: true, bots: "loading" } as const;
  const connecting = { connection: "connecting", configured: false, bots: "none" } as const;
  const unreachable = { connection: "unreachable", configured: false, bots: "none" } as const;

  it("waits for machines on their first attempt and connected ones' bot lists, then stays settled", () => {
    expect(railBotsSettled(false, [connecting])).toBe(false);
    expect(railBotsSettled(false, [{ ...answered, configured: false, bots: "none" }])).toBe(false);
    expect(railBotsSettled(false, [answered, loading])).toBe(false);

    const settled = railBotsSettled(false, [answered, { ...answered, bots: "none" }]);
    expect(settled).toBe(true);
    expect(railBotsSettled(settled, [answered, loading])).toBe(true);
  });

  it("doesn't wait on a machine that can't be reached, so its cached rows show at once", () => {
    expect(railBotsSettled(false, [unreachable])).toBe(true);
    expect(railBotsSettled(false, [answered, unreachable])).toBe(true);
  });

  it("settles once a connected machine shows a bot, without waiting on slower machines", () => {
    const shown = { ...answered, bots: "shown" } as const;
    expect(railBotsSettled(false, [shown, connecting, loading])).toBe(true);
    expect(railBotsSettled(false, [{ ...shown, connection: "unreachable" }, connecting])).toBe(
      false,
    );
  });
});

describe("resolveSidebarLayout", () => {
  const layout = (input: Partial<Parameters<typeof resolveSidebarLayout>[0]>) =>
    resolveSidebarLayout({
      botsSettled: true,
      projectsPicked: false,
      showsRail: true,
      hasActiveBot: false,
      foldersSetting: false,
      ...input,
    });

  it("waits for the bots before choosing between cards and Projects, unless Projects is picked", () => {
    expect(layout({ botsSettled: false })).toBe("pending");
    expect(layout({ botsSettled: false, showsRail: false, foldersSetting: true })).toBe("pending");
    expect(layout({ botsSettled: false, projectsPicked: true })).toBe("projects");
    expect(layout({ botsSettled: false, projectsPicked: true, showsRail: false })).toBe("pending");

    expect(layout({})).toBe("projects");
    expect(layout({ hasActiveBot: true })).toBe("cards");
    expect(layout({ showsRail: false })).toBe("cards");
    expect(layout({ hasActiveBot: true, foldersSetting: true })).toBe("folders");
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

  it("selects only the projects each entry owns", () => {
    expect([...logicalBotProjectKeys(bots[1]!, bots, projects)]).toEqual(["local:a"]);
    // The same-named bot on remote is another entry, with its own project.
    expect([...logicalBotProjectKeys(bots[4]!, bots, projects)]).toEqual(["remote:b"]);
    // remote:c has no owner, so it shows under no bot, not even one on its machine.
    expect([...logicalBotProjectKeys(bots[2]!, bots, projects)]).toEqual([]);
    expect([...logicalBotProjectKeys(bots[0]!, bots, projects)]).toEqual([]);
  });

  it("lists another machine's project only under the bot that owns it", () => {
    const vps = EnvironmentId.make("vps");
    const vpsBots = [
      ...bots,
      ...buildLogicalBots([{ environmentId: vps, bots: [bot("bot-vps", "Ops", 0)] }]),
    ];
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
      {
        environmentId: vps,
        id: "lent",
        botId: null,
        remoteBot: { environmentId: local, botId: "bot-social", name: "Social", homeLabel: "Mac" },
      },
    ];
    // Neither a machine link nor a machine without bots puts a project under a bot.
    const permitted = { ...vpsBots[1]!, linkedEnvironmentIds: [remote, vps] };
    expect([...logicalBotProjectKeys(permitted, vpsBots, linked)]).toEqual(["vps:lent"]);
    expect([...logicalBotProjectKeys(vpsBots.at(-1)!, vpsBots, linked)]).toEqual([
      "vps:owned-there",
      "remote:given",
    ]);
    // Until the rail lists the VPS's bot, its projects show under no bot.
    for (const entry of bots) {
      expect(logicalBotProjectKeys(entry, bots, linked).has("remote:given")).toBe(false);
    }
  });

  it("splits an entry's projects into owned, addable on linked machines, and without bots", () => {
    const vps = EnvironmentId.make("vps");
    const withVps = [...projects, { environmentId: vps, id: "omni" }];
    const social = bots[1]!;
    const linked = new Set([local, remote, vps]);
    const lists = logicalBotProjectLists(social, bots, withVps, new Set([local, remote]), linked);
    expect(lists.owned.map((project) => project.id)).toEqual(["a"]);
    // Addable on any machine linked to its home.
    expect(lists.available.map((project) => project.id)).toEqual(["b", "c", "d"]);
    expect(lists.withoutBots.map((project) => project.id)).toEqual(["omni"]);

    // Without a link, another machine's projects don't show, except those Social owns there.
    const given = [
      ...withVps,
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
    const homeOnly = logicalBotProjectLists(social, bots, given, linked, new Set([local]));
    expect(homeOnly.owned.map((project) => project.id)).toEqual(["a", "e"]);
    expect(homeOnly.available.map((project) => project.id)).toEqual(["d"]);
    expect(homeOnly.withoutBots).toEqual([]);
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
    row: {
      readonly lineage?: {
        readonly parentThreadId: ThreadId | null;
        readonly relationshipToParent: "fork" | "subagent" | null;
        readonly rootThreadId: ThreadId;
        readonly sideChat?: boolean;
        readonly listed?: boolean;
        readonly workflowStep?: boolean;
      };
      readonly feature?: {
        readonly id: string;
        readonly title: string;
        readonly member?: string;
        readonly parentFeatureId?: string;
      };
      readonly crewRequest?: {
        readonly id: string;
        readonly title: string;
        readonly member: string;
      };
      readonly createdAt?: string;
    } = {},
  ) => ({
    environmentId: local,
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: id,
    createdAt: row.createdAt ?? "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    settledOverride: null,
    crewRequest: row.crewRequest ?? null,
    archivedAt: null,
    lastVisitedAt,
    lineage: row.lineage ?? {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: ThreadId.make(id),
    },
    feature: row.feature ?? null,
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
  // Rows as the thread list arranges them, as the web atom computes them.
  const activityOf = (
    shells: ReadonlyArray<ReturnType<typeof shell>>,
    delegatedUnderParent: ReadonlySet<string> = new Set(),
  ) => botActivityByBot(shells, projects, listRowThreadKeys(shells, delegatedUnderParent));

  it("flags failed, working and unread threads under their bot", () => {
    const activity = activityOf([
      shell("failed", "p-social", { status: "failed", completedAt: after }, before),
      shell("working", "p-captain", { status: "running", completedAt: null }, before),
      shell("done", "p-captain", { status: "completed", completedAt: after }, before),
      // A project with no bot is no bot's activity.
      shell("loose", "p-loose", { status: "running", completedAt: null }, before),
      // Opened since it finished: nothing to flag.
      shell("seen", "p-social", { status: "completed", completedAt: before }, after),
    ]);
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
    const activity = activityOf([
      shell(
        botHeadquartersThreadId("bot-social"),
        "scratch",
        { status: "completed", completedAt: after },
        before,
      ),
      shell("old-server", "p-captain", { status: "failed", completedAt: after }, undefined),
    ]);
    expect([...activity.keys()]).toEqual([botNeedsYouKey(local, "bot-social")]);
  });

  const finished = { status: "completed" as const, completedAt: after };
  const running = { status: "running" as const, completedAt: null };
  const child = (parent: string, extra: { sideChat?: boolean; workflowStep?: boolean } = {}) => ({
    lineage: {
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: extra.sideChat ? null : ("subagent" as const),
      rootThreadId: ThreadId.make(parent),
      ...extra,
    },
  });
  const crew = { feature: { id: "f-1", title: "Feature", member: "Builder" } };

  it("lights unread only for threads that are their own row in the bot's list", () => {
    const activity = activityOf(
      [
        shell("lead", "p-social", finished, after, { feature: { id: "f-1", title: "Feature" } }),
        shell("crew", "p-social", finished, before, crew),
        shell("subagent", "p-social", finished, before, child("lead")),
        shell("side-chat", "p-social", finished, before, child("lead", { sideChat: true })),
        shell("step", "p-social", finished, before, child("lead", { workflowStep: true })),
        shell("delegated", "p-social", finished, before),
        shell(
          projectHeadquartersThreadId(ProjectId.make("p-social")),
          "p-social",
          finished,
          before,
        ),
        // Hidden threads still mean the bot is working.
        shell("crew-running", "p-social", running, before, crew),
      ],
      new Set([threadKey({ environmentId: local, threadId: ThreadId.make("delegated") })]),
    );
    expect(activity.get(botNeedsYouKey(local, "bot-social"))).toEqual({
      failed: false,
      working: true,
      unread: false,
    });
  });

  it("still lights unread for a feature's lead and a headquarters", () => {
    const activity = activityOf([
      shell("lead", "p-social", finished, before, { feature: { id: "f-1", title: "Feature" } }),
      shell(botHeadquartersThreadId(CAPTAIN_ID), "scratch", finished, before),
    ]);
    expect(activity.get(botNeedsYouKey(local, "bot-social"))?.unread).toBe(true);
    expect(activity.get(botNeedsYouKey(local, CAPTAIN_ID))?.unread).toBe(true);
  });

  it("leaves out threads folded into another row once that row is read", () => {
    const feature = { id: "f-1", title: "Feature" };
    const activity = activityOf([
      // The feature's row is its lead, read since everything finished.
      shell("lead", "p-social", finished, after, { feature, createdAt: before }),
      // A second thread on the feature that no crew member runs folds into the lead's row.
      shell("extra", "p-social", finished, before, { feature, createdAt: after }),
      // A child feature's lead folds under its parent's row.
      shell("child-lead", "p-social", finished, before, {
        feature: { id: "f-2", title: "Child", parentFeatureId: "f-1" },
      }),
      // A bot request's earlier attempt folds into its latest one.
      shell("try-1", "p-captain", finished, before, {
        crewRequest: { id: "r-1", title: "Request", member: "Builder" },
        createdAt: before,
      }),
      shell("try-2", "p-captain", finished, after, {
        crewRequest: { id: "r-1", title: "Request", member: "Builder" },
        createdAt: after,
      }),
    ]);
    expect(activity.get(botNeedsYouKey(local, "bot-social"))).toBeUndefined();
    expect(activity.get(botNeedsYouKey(local, CAPTAIN_ID))).toBeUndefined();
  });

  it("gives a project manager its project group's rows and its own thread", () => {
    const manager = projectHeadquartersThreadId(ProjectId.make("p-loose"));
    const shells = [
      shell(manager, "p-loose", finished, before),
      shell("crew", "p-social", finished, before, crew),
      shell("crew-running", "p-social", running, before, crew),
      shell("failed", "p-captain", { status: "failed", completedAt: after }, before),
    ];
    const byProject = activityByProject(shells, listRowThreadKeys(shells, new Set()));
    expect(activityForProjects(byProject, [`${local}:p-loose`])).toEqual({
      failed: false,
      working: false,
      unread: true,
    });
    expect(activityForProjects(byProject, [`${local}:p-social`, `${local}:p-captain`])).toEqual({
      failed: true,
      working: true,
      unread: true,
    });
    expect(activityForProjects(byProject, [`${remote}:p-loose`])).toBeUndefined();
    expect(
      needsYouForProjects(
        new Map([
          [`${local}:p-loose`, 2],
          [`${local}:p-social`, 1],
          [`${remote}:p-loose`, 4],
        ]),
        [`${local}:p-loose`, `${local}:p-social`],
      ),
    ).toBe(3);
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
