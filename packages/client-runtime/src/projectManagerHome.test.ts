import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyManagerPlacement,
  type ManagerCopy,
  type ManagerPlacementWrite,
  planManagerPlacement,
} from "./projectManagerHome.ts";

const mac = EnvironmentId.make("environment-mac");
const box = EnvironmentId.make("environment-box");
const vps = EnvironmentId.make("environment-vps");

const copy = (environmentId: EnvironmentId, overrides: Partial<ManagerCopy> = {}): ManagerCopy => ({
  environmentId,
  projectId: ProjectId.make(`project:web:${environmentId}`),
  label: environmentId.replace("environment-", ""),
  hasManager: false,
  botHome: mac,
  ...overrides,
});
const pointsAt = (home: ManagerCopy) => ({
  environmentId: home.environmentId,
  projectId: home.projectId,
  homeLabel: home.label,
});

describe("planManagerPlacement", () => {
  it("keeps the bot's home's manager when both machines have one, and retires the other", () => {
    const copies = [copy(box, { hasManager: true }), copy(mac, { hasManager: true })];
    expect(planManagerPlacement(copies)).toEqual({
      away: [
        {
          environmentId: box,
          input: { projectId: copies[0]!.projectId, remoteManager: pointsAt(copies[1]!) },
        },
      ],
      home: { environmentId: mac, input: { projectId: copies[1]!.projectId } },
    });
  });

  it("keeps the one manager there is, wherever its bot lives", () => {
    const copies = [copy(box, { hasManager: true }), copy(mac)];
    expect(planManagerPlacement(copies).home?.environmentId).toBe(box);
  });

  it("puts a new manager on its bot's home, else on the same machine for every client", () => {
    expect(planManagerPlacement([copy(box), copy(mac)]).home?.environmentId).toBe(mac);
    const noBot = { botHome: null };
    expect(planManagerPlacement([copy(vps, noBot), copy(box, noBot)]).home).toEqual({
      environmentId: box,
      input: { projectId: copy(box).projectId },
    });
  });

  it("changes nothing once the copies agree, or name a home this client can't see", () => {
    const home = copy(mac, { hasManager: true });
    expect(planManagerPlacement([home, copy(box, { remoteManager: pointsAt(home) })])).toEqual({
      away: [],
      home: null,
    });
    const unseen = {
      environmentId: vps,
      projectId: ProjectId.make("project:web:vps"),
      homeLabel: "vps",
    };
    expect(
      planManagerPlacement([copy(mac, { hasManager: true }), copy(box, { remoteManager: unseen })]),
    ).toEqual({ away: [], home: null });
    // Halfway through a move from mac to box, each names the other: the mover finishes it.
    const leaving = copy(mac);
    const arriving = copy(box);
    expect(
      planManagerPlacement([
        { ...leaving, remoteManager: pointsAt(arriving) },
        { ...arriving, remoteManager: pointsAt(leaving) },
      ]),
    ).toEqual({ away: [], home: null });
    expect(planManagerPlacement([copy(mac, { hasManager: true })])).toEqual({
      away: [],
      home: null,
    });
    // Two checkouts on one machine keep a manager each.
    const second = { ...copy(mac, { hasManager: true }), projectId: ProjectId.make("project:2") };
    expect(planManagerPlacement([copy(mac, { hasManager: true }), second])).toEqual({
      away: [],
      home: null,
    });
  });

  it("moves the manager to the machine the person picks, and back", () => {
    const home = copy(mac, { hasManager: true });
    const other = copy(box, { remoteManager: pointsAt(home) });
    const moved = planManagerPlacement([home, other], other);
    expect(moved.away).toEqual([
      { environmentId: mac, input: { projectId: home.projectId, remoteManager: pointsAt(other) } },
    ]);
    expect(moved.home).toEqual({
      environmentId: box,
      input: { projectId: other.projectId, remoteManager: null },
    });
  });
});

describe("applyManagerPlacement", () => {
  it("tells the kept manager which copy's manager it retired, after that copy moved", async () => {
    const copies = [copy(box, { hasManager: true }), copy(mac, { hasManager: true })];
    const sent: Array<ManagerPlacementWrite> = [];
    const retiredThreadId = ThreadId.make("bot-run:project-hq:project:web:environment-box");
    const failure = await applyManagerPlacement(
      planManagerPlacement(copies),
      copies,
      async (write) => {
        sent.push(write);
        return { ok: true, retiredThreadId: write.environmentId === box ? retiredThreadId : null };
      },
    );
    expect(failure).toBeNull();
    expect(sent.map((write) => write.environmentId)).toEqual([box, mac]);
    expect(sent[1]!.input).toEqual({
      projectId: copies[1]!.projectId,
      retired: { environmentLabel: "box", threadId: retiredThreadId },
    });
  });

  it("stops at a failed write, before the home hears of a move that didn't happen", async () => {
    const copies = [copy(box, { hasManager: true }), copy(mac, { hasManager: true })];
    const sent: Array<EnvironmentId> = [];
    const failure = await applyManagerPlacement(
      planManagerPlacement(copies),
      copies,
      async (write) => {
        sent.push(write.environmentId);
        return { ok: false, failure: "box is offline" };
      },
    );
    expect(failure).toBe("box is offline");
    expect(sent).toEqual([box]);
  });
});
