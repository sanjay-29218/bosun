// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  FEATURE_DELIVERY_WORKFLOW_ID,
  FEATURE_MANAGER_ROLE_ID,
  type LibraryCopy,
  OrchestratorMcpFailure,
  type PeerLinkSummary,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import type { LibraryCopySet } from "../mcp/toolkits/bots/linkTools.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { CrewTestOrchestration } from "./CrewRuntime.testkit.ts";
import { CrewService } from "./CrewService.ts";
import { type LibraryError, LibraryCopies, layer as LibraryCopiesLayer } from "./LibraryCopies.ts";
import { CrewRuntimeLive } from "./runtimeLayer.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const laptopId = EnvironmentId.make("env-laptop");
const boxId = EnvironmentId.make("env-box");
const laptopOwner = { environmentId: laptopId, label: "Laptop" };

/** The machines a fake peer link reaches, which of them are off, and who links to whom. */
interface Network {
  readonly receivers: Map<EnvironmentId, CrewService["Service"]>;
  readonly offline: Set<EnvironmentId>;
  readonly links: Map<EnvironmentId, Set<EnvironmentId>>;
  /** Machines with Linked environments turned off. */
  readonly betaOff: Set<EnvironmentId>;
}

/** Like the real link: an `orchestration_error` while the machine is off. */
const fakeForwarding = (network: Network) =>
  Layer.mock(PeerForwarding.PeerForwarding)({
    call: (_scope, _tool, environmentId, params) => {
      const receiver = network.receivers.get(environmentId);
      if (receiver === undefined || network.offline.has(environmentId)) {
        return Effect.fail(
          new OrchestratorMcpFailure({ code: "orchestration_error", message: "Not answering." }),
        );
      }
      return receiver.applyLibraryCopy(params as LibraryCopySet).pipe(
        Effect.map((refused) => ({ refused })),
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
        ),
      ) as never;
    },
  });

const fakeLinks = (network: Network, environmentId: EnvironmentId) => {
  const linked = () => network.links.get(environmentId) ?? new Set<EnvironmentId>();
  return Layer.mock(PeerLinks.PeerLinks)({
    enabled: Effect.sync(() => !network.betaOff.has(environmentId)),
    list: Effect.sync(() =>
      [...linked()].map((id) => ({ environmentId: id }) as unknown as PeerLinkSummary),
    ),
    unlink: (id) => Effect.sync(() => linked().delete(id)),
  });
};

const machine = (environmentId: EnvironmentId, label: string, network: Network) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "library-copies-")),
    );
    const crewLayer = Layer.mergeAll(
      CrewTestOrchestration,
      CrewRuntimeLive.pipe(Layer.provide(CrewTestOrchestration)),
    ).pipe(
      Layer.provideMerge(SqlitePersistence.layerFromPath(NodePath.join(directory, "state.sqlite"))),
      Layer.provideMerge(ServerConfig.layerTest(directory, { prefix: "library-copies-" })),
      Layer.provideMerge(
        Layer.mock(ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label,
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          }),
        }),
      ),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const context = yield* Layer.build(
      Layer.fresh(
        LibraryCopiesLayer.pipe(
          Layer.provideMerge(crewLayer),
          Layer.provide(fakeForwarding(network)),
          Layer.provide(fakeLinks(network, environmentId)),
        ),
      ),
    );
    const crew = Context.get(context, CrewService);
    yield* crew.ensureDefaults(modelSelection);
    network.receivers.set(environmentId, crew);
    return { crew, copies: Context.get(context, LibraryCopies) };
  });

/** The laptop links the box; the box doesn't link back unless a test says so. */
const twoMachines = Effect.gen(function* () {
  const network: Network = {
    receivers: new Map(),
    offline: new Set(),
    links: new Map([[laptopId, new Set([boxId])]]),
    betaOff: new Set(),
  };
  const laptop = yield* machine(laptopId, "Laptop", network);
  const box = yield* machine(boxId, "Box", network);
  return { network, laptop, box };
});

const release = {
  id: "workflow:release",
  name: "Release",
  instructions: "Have the Writer write the notes, then ship.",
  leadRoleId: FEATURE_MANAGER_ROLE_ID,
  crewRoleIds: ["role:writer"],
};
const writer = {
  id: "role:writer",
  name: "Writer",
  instructions: "Write release notes.",
  modelSelection,
};

const copiesOf = (copies: LibraryCopies["Service"], kind: "workflow" | "role", id: string) => {
  const items: Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly copies: ReadonlyArray<LibraryCopy> }>,
    LibraryError
  > = kind === "workflow" ? copies.listWorkflows : copies.listRoles;
  return items.pipe(Effect.map((listed) => listed.find((item) => item.id === id)?.copies ?? []));
};

/** The laptop changes Feature delivery, so a machine with the stock one takes the laptop's. */
const changeDelivery = (laptop: {
  readonly crew: CrewService["Service"];
  readonly copies: LibraryCopies["Service"];
}) =>
  Effect.gen(function* () {
    const delivery = (yield* laptop.crew.getWorkflow(FEATURE_DELIVERY_WORKFLOW_ID))!;
    yield* laptop.copies.updateWorkflow({
      ...delivery,
      instructions: "The laptop's way.",
      expectedRevision: delivery.revision,
    });
  });

describe("LibraryCopies", () => {
  it.effect(
    "a linked machine gets every workflow and role, read-only there, and edits follow",
    () =>
      Effect.gen(function* () {
        const { laptop, box } = yield* twoMachines;
        yield* laptop.copies.createRole(writer);
        yield* laptop.copies.createWorkflow(release);
        yield* changeDelivery(laptop);
        yield* laptop.copies.push;

        expect(yield* box.crew.getWorkflow(release.id)).toMatchObject({
          instructions: release.instructions,
          crewRoleIds: ["role:writer"],
          managedFrom: laptopOwner,
        });
        expect(yield* box.crew.getRole("role:writer")).toMatchObject({
          name: "Writer",
          managedFrom: laptopOwner,
        });
        // The box's stock Feature delivery takes the laptop's changed one. Built-ins the same on
        // both stay the box's own, and read as delivered.
        expect(yield* box.crew.getWorkflow(FEATURE_DELIVERY_WORKFLOW_ID)).toMatchObject({
          instructions: "The laptop's way.",
          managedFrom: laptopOwner,
        });
        expect((yield* box.crew.getRole(FEATURE_MANAGER_ROLE_ID))?.managedFrom).toBeNull();
        expect(yield* copiesOf(laptop.copies, "role", FEATURE_MANAGER_ROLE_ID)).toMatchObject([
          { environmentId: boxId, deliveredRevision: 1, problem: null },
        ]);
        expect(yield* copiesOf(laptop.copies, "workflow", release.id)).toMatchObject([
          { environmentId: boxId, deliveredRevision: 1, problem: null },
        ]);
        // A copy lists no machines of its own.
        expect(yield* copiesOf(box.copies, "workflow", release.id)).toEqual([]);

        // A copy is edited where it was made.
        const copy = (yield* box.crew.getWorkflow(release.id))!;
        const refused = yield* Effect.flip(
          box.copies.updateWorkflow({ ...release, name: "Mine", expectedRevision: copy.revision }),
        );
        expect(refused.message).toBe("Release is managed from Laptop. Edit it there.");
        expect((yield* Effect.flip(box.copies.deleteWorkflow(release.id))).message).toContain(
          "managed from Laptop",
        );
        expect(
          (yield* Effect.flip(
            box.crew.updateRole({ ...writer, enabled: false, expectedRevision: 1 }),
          )).message,
        ).toBe("Writer is managed from Laptop. Edit it there.");

        // Edits and deletes on the owner follow.
        yield* laptop.copies.updateWorkflow({
          ...release,
          instructions: "Ship on Fridays.",
          expectedRevision: 1,
        });
        yield* laptop.copies.updateRole({
          ...writer,
          name: "Copywriter",
          enabled: true,
          expectedRevision: 1,
        });
        yield* laptop.copies.push;
        expect((yield* box.crew.getWorkflow(release.id))?.instructions).toBe("Ship on Fridays.");
        expect((yield* box.crew.getRole("role:writer"))?.name).toBe("Copywriter");
        expect(yield* copiesOf(laptop.copies, "workflow", release.id)).toMatchObject([
          { environmentId: boxId, deliveredRevision: 2 },
        ]);
        yield* laptop.copies.deleteWorkflow(release.id);
        yield* laptop.copies.push;
        expect(yield* box.crew.getWorkflow(release.id)).toBeNull();
      }),
  );

  it.effect("a machine that was off gets the copies once it answers", () =>
    Effect.gen(function* () {
      const { network, laptop, box } = yield* twoMachines;
      network.offline.add(boxId);
      yield* laptop.copies.createRole(writer);
      yield* laptop.copies.push;
      expect(yield* box.crew.getRole("role:writer")).toBeNull();
      expect(yield* copiesOf(laptop.copies, "role", writer.id)).toEqual([]);

      // With Linked environments off on the laptop, nothing goes and nothing reads as failed.
      network.offline.delete(boxId);
      network.betaOff.add(laptopId);
      yield* laptop.copies.push;
      expect(yield* box.crew.getRole("role:writer")).toBeNull();
      expect(yield* copiesOf(laptop.copies, "role", writer.id)).toEqual([]);
      network.betaOff.delete(laptopId);

      yield* laptop.copies.push;
      expect((yield* box.crew.getRole("role:writer"))?.managedFrom).toEqual(laptopOwner);
      expect(yield* copiesOf(laptop.copies, "role", writer.id)).toMatchObject([
        { environmentId: boxId, deliveredRevision: 1 },
      ]);
    }),
  );

  it.effect("linked both ways, each machine owns what it made and copies nothing on", () =>
    Effect.gen(function* () {
      const { network, laptop, box } = yield* twoMachines;
      network.links.set(boxId, new Set([laptopId]));
      yield* laptop.copies.createRole(writer);
      yield* box.copies.createRole({ ...writer, id: "role:tester", name: "Tester" });
      yield* laptop.copies.push;
      yield* box.copies.push;
      yield* laptop.copies.push;

      expect((yield* laptop.crew.getRole("role:tester"))?.managedFrom).toEqual({
        environmentId: boxId,
        label: "Box",
      });
      expect((yield* box.crew.getRole("role:writer"))?.managedFrom).toEqual(laptopOwner);
      // The box never sends back what it got from the laptop, and stock built-ins pushed both
      // ways stay each machine's own.
      expect((yield* laptop.crew.getRole("role:writer"))?.managedFrom).toBeNull();
      expect((yield* laptop.crew.getRole(FEATURE_MANAGER_ROLE_ID))?.managedFrom).toBeNull();
      expect((yield* box.crew.getRole(FEATURE_MANAGER_ROLE_ID))?.managedFrom).toBeNull();
      expect(yield* copiesOf(box.copies, "role", FEATURE_MANAGER_ROLE_ID)).toMatchObject([
        { environmentId: laptopId, problem: null },
      ]);
    }),
  );

  it.effect("unlinking removes the copies, and keeps what the machine still needs", () =>
    Effect.gen(function* () {
      const { network, laptop, box } = yield* twoMachines;
      yield* laptop.copies.createRole(writer);
      yield* laptop.copies.createRole({ ...writer, id: "role:editor", name: "Editor" });
      yield* laptop.copies.createWorkflow(release);
      yield* changeDelivery(laptop);
      yield* laptop.copies.push;
      // The box's own workflow leads with a role it got from the laptop.
      yield* box.copies.createWorkflow({
        ...release,
        id: "workflow:box-notes",
        name: "Box notes",
        leadRoleId: "role:writer",
        crewRoleIds: [],
      });

      expect(yield* laptop.copies.unlink(boxId)).toBe(true);
      expect(network.links.get(laptopId)?.has(boxId)).toBe(false);
      expect(yield* box.crew.getWorkflow(release.id)).toBeNull();
      expect(yield* box.crew.getRole("role:editor")).toBeNull();
      expect(yield* box.crew.getRole("role:writer")).toMatchObject({ managedFrom: null });
      // The box keeps Feature delivery as it last got it, now its own to edit.
      expect(yield* box.crew.getWorkflow(FEATURE_DELIVERY_WORKFLOW_ID)).toMatchObject({
        instructions: "The laptop's way.",
        managedFrom: null,
      });
    }),
  );

  it.effect("a machine's own one with the same id is kept, shown, and replaced once it goes", () =>
    Effect.gen(function* () {
      const { laptop, box } = yield* twoMachines;
      yield* box.copies.createRole({ ...writer, name: "Box writer" });
      const builder = (yield* box.crew.getRole("role:builder"))!;
      yield* box.copies.updateRole({
        ...builder,
        instructions: "Build the box's way.",
        expectedRevision: builder.revision,
      });
      yield* box.copies.createWorkflow({ ...release, crewRoleIds: [], name: "Box release" });
      yield* laptop.copies.createRole(writer);
      yield* laptop.copies.createWorkflow(release);
      yield* laptop.copies.push;

      expect(yield* box.crew.getRole("role:writer")).toMatchObject({
        name: "Box writer",
        managedFrom: null,
      });
      expect((yield* box.crew.getRole("role:builder"))?.instructions).toBe("Build the box's way.");
      expect(yield* copiesOf(laptop.copies, "role", writer.id)).toMatchObject([
        { deliveredRevision: null, problem: "It has its own Box writer." },
      ]);
      expect(yield* copiesOf(laptop.copies, "role", "role:builder")).toMatchObject([
        { deliveredRevision: null, problem: "It has its own Builder." },
      ]);
      expect(yield* copiesOf(laptop.copies, "workflow", release.id)).toMatchObject([
        { deliveredRevision: null, problem: "It has its own Box release." },
      ]);

      // Nothing changed on the laptop, and the next push still delivers once the box's goes.
      yield* box.copies.deleteWorkflow(release.id);
      yield* laptop.copies.push;
      expect((yield* box.crew.getWorkflow(release.id))?.managedFrom).toEqual(laptopOwner);
      expect(yield* copiesOf(laptop.copies, "workflow", release.id)).toMatchObject([
        { deliveredRevision: 1, problem: null },
      ]);
    }),
  );
});
