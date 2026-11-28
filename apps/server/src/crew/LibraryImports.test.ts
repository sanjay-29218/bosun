// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  libraryImportState,
  OrchestratorMcpFailure,
  type PeerLink,
  PLANNER_ROLE_ID,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { LibrarySyncInput } from "../mcp/toolkits/bots/linkTools.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { CrewChanges } from "./CrewChanges.ts";
import { CrewTestOrchestration } from "./CrewRuntime.testkit.ts";
import { CrewService } from "./CrewService.ts";
import { CrewStore } from "./CrewStore.ts";
import { LibraryImports, layer as LibraryImportsLayer } from "./LibraryImports.ts";
import { CrewRuntimeLive } from "./runtimeLayer.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const laptopId = EnvironmentId.make("env-laptop");
const boxId = EnvironmentId.make("env-box");

/** The machines a fake peer link reaches, which are off or older, and who links to whom. */
interface Network {
  readonly receivers: Map<EnvironmentId, LibraryImports["Service"]>;
  readonly offline: Set<EnvironmentId>;
  readonly older: Set<EnvironmentId>;
  readonly links: Map<EnvironmentId, Set<EnvironmentId>>;
  /** Every sync sent, as it went over the wire. */
  readonly sent: Array<LibrarySyncInput>;
  /** Run before the next calls are answered, one each, to hold a call in flight. */
  readonly beforeAnswer: Array<Effect.Effect<void>>;
  /** Run as a machine next enters a transaction, one each, to hold it at the door. */
  readonly onTransaction: Map<EnvironmentId, Array<Effect.Effect<void>>>;
  /** Run as a machine next reports a change, after it committed, one each, to hold it there. */
  readonly onChange: Map<EnvironmentId, Array<Effect.Effect<void>>>;
}

/** How the source sees the importer's link: a full-access link session. */
const linkScope = (environmentId: EnvironmentId): McpInvocationScope => ({
  environmentId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  thread: undefined,
  client: { sessionId: "link", label: "link", access: "full-access", linked: true },
});

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
      if (network.older.has(environmentId)) {
        return Effect.fail(
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Tool 't3_crew_link_library_sync' not found",
          }),
        );
      }
      network.sent.push(params as LibrarySyncInput);
      const hold = network.beforeAnswer.shift() ?? Effect.void;
      return hold.pipe(
        Effect.andThen(receiver.serveSync(linkScope(environmentId), params as LibrarySyncInput)),
      ) as never;
    },
  });

const fakeLinks = (network: Network, environmentId: EnvironmentId) => {
  const linked = () => network.links.get(environmentId) ?? new Set<EnvironmentId>();
  const link = (id: EnvironmentId) =>
    ({
      environmentId: id,
      label: id === boxId ? "Box" : "Laptop",
      expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
    }) as unknown as PeerLink;
  return Layer.mock(PeerLinks.PeerLinks)({
    enabled: Effect.succeed(true),
    get: (id) => Effect.sync(() => (linked().has(id) ? Option.some(link(id)) : Option.none())),
    unlink: (id) => Effect.sync(() => ({ removed: linked().delete(id), endedThere: false })),
  });
};

/** The real SQL client, except that a transaction can be held before it begins. */
const heldSql = <E, R>(
  sqlite: Layer.Layer<SqlClient.SqlClient, E, R>,
  next: () => Effect.Effect<void> | undefined,
) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.map(SqlClient.SqlClient, (sql) => {
      const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
        Effect.suspend(() => next() ?? Effect.void).pipe(
          Effect.andThen(sql.withTransaction(effect)),
        );
      return new Proxy(sql, {
        get: (target, key, receiver) =>
          key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
      });
    }),
  ).pipe(Layer.provideMerge(sqlite));

const machine = (environmentId: EnvironmentId, label: string, network: Network) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "library-imports-")),
    );
    const crewLayer = Layer.mergeAll(
      CrewTestOrchestration,
      CrewRuntimeLive.pipe(Layer.provide(CrewTestOrchestration)),
    ).pipe(
      Layer.provideMerge(
        heldSql(SqlitePersistence.layerFromPath(NodePath.join(directory, "state.sqlite")), () =>
          network.onTransaction.get(environmentId)?.shift(),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(CrewChanges, {
          revision: Effect.succeed({ bots: 0, library: 0, features: 0 }),
          changes: Stream.empty,
          bump: () =>
            Effect.suspend(() => network.onChange.get(environmentId)?.shift() ?? Effect.void),
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(directory, { prefix: "library-imports-" })),
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
        LibraryImportsLayer.pipe(
          Layer.provideMerge(crewLayer),
          Layer.provide(fakeForwarding(network)),
          Layer.provide(fakeLinks(network, environmentId)),
        ),
      ),
    );
    const crew = Context.get(context, CrewService);
    yield* crew.ensureDefaults(modelSelection);
    const library = Context.get(context, LibraryImports);
    network.receivers.set(environmentId, library);
    return { crew, store: Context.get(context, CrewStore), library };
  });

/** The laptop links the box, so the laptop can import from it; the box can't call back. */
const twoMachines = Effect.gen(function* () {
  const network: Network = {
    receivers: new Map(),
    offline: new Set(),
    older: new Set(),
    beforeAnswer: [],
    onTransaction: new Map(),
    onChange: new Map(),
    links: new Map([[laptopId, new Set([boxId])]]),
    sent: [],
  };
  const laptop = yield* machine(laptopId, "Laptop", network);
  const box = yield* machine(boxId, "Box", network);
  return { network, laptop, box };
});

const release = {
  id: "workflow:release",
  name: "Release",
  instructions: "Have the Writer write the notes, then ship.",
  crewRoleIds: ["role:writer"],
};
const writer = {
  id: "role:writer",
  name: "Writer",
  instructions: "Write release notes.",
  modelSelection,
};

const nothing = { roleIds: [], workflowIds: [], replace: false };

const roleOn = (library: LibraryImports["Service"], id: string) =>
  library.listRoles.pipe(Effect.map((roles) => roles.find((role) => role.id === id)!));

describe("LibraryImports", () => {
  it.effect(
    "nothing is copied without an import; an import is editable and remembers its source",
    () =>
      Effect.gen(function* () {
        const { laptop, box } = yield* twoMachines;
        yield* box.library.createRole(writer);
        yield* box.library.createWorkflow(release);
        yield* laptop.library.syncNow;
        expect(yield* laptop.crew.getWorkflow(release.id)).toBeNull();

        const listed = yield* laptop.library.importable(boxId);
        expect(listed.problem).toBeNull();
        expect(listed.items.find((item) => item.id === release.id)).toMatchObject({
          kind: "workflow",
          status: "new",
          crewRoleIds: ["role:writer"],
        });
        // The box's starter Planner would replace the laptop's own.
        expect(listed.items.find((item) => item.id === PLANNER_ROLE_ID)).toMatchObject({
          status: "replaces",
          replaces: { name: "Planner", importedFrom: null, stock: true },
        });

        // A workflow brings the roles it names that the laptop lacks.
        const result = yield* laptop.library.importItems({
          ...nothing,
          sourceEnvironmentId: boxId,
          workflowIds: [release.id],
        });
        expect(result.imported.map((item) => item.id).sort()).toEqual([writer.id, release.id]);
        const imported = yield* roleOn(laptop.library, writer.id);
        expect(imported.importedFrom).toMatchObject({ environmentId: boxId, label: "Box" });
        expect(libraryImportState(imported)).toEqual({ edited: false, updateAvailable: false });

        // Editable here, and then edited.
        const edited = yield* laptop.library.updateRole({
          ...writer,
          instructions: "Write short notes.",
          expectedRevision: imported.revision,
          enabled: true,
        });
        expect(libraryImportState(edited)).toEqual({ edited: true, updateAvailable: false });

        // The box learns who holds it on the laptop's next sync.
        yield* laptop.library.syncNow;
        expect((yield* roleOn(box.library, writer.id)).importers).toMatchObject([
          { environmentId: laptopId, label: "Laptop", edited: true, pending: false },
        ]);
      }),
  );

  it.effect(
    "an edit on the source shows Update available; Skip hides it, Take update applies it",
    () =>
      Effect.gen(function* () {
        const { laptop, box } = yield* twoMachines;
        const original = yield* box.library.createRole(writer);
        yield* laptop.library.importItems({
          ...nothing,
          sourceEnvironmentId: boxId,
          roleIds: [writer.id],
        });
        yield* box.library.updateRole({
          ...writer,
          instructions: "Write notes with links.",
          expectedRevision: original.revision,
          enabled: true,
        });
        yield* laptop.library.syncNow;
        expect(libraryImportState(yield* roleOn(laptop.library, writer.id)).updateAvailable).toBe(
          true,
        );

        yield* laptop.library.detach({ kind: "role", id: writer.id, mode: "skip" });
        expect(libraryImportState(yield* roleOn(laptop.library, writer.id)).updateAvailable).toBe(
          false,
        );

        yield* laptop.library.importItems({
          ...nothing,
          sourceEnvironmentId: boxId,
          roleIds: [writer.id],
        });
        const taken = yield* roleOn(laptop.library, writer.id);
        expect(taken.instructions).toBe("Write notes with links.");
        expect(libraryImportState(taken)).toEqual({ edited: false, updateAvailable: false });

        // Keep as my own: no source, no badge, and the box forgets the laptop.
        yield* laptop.library.detach({ kind: "role", id: writer.id, mode: "detach" });
        expect((yield* roleOn(laptop.library, writer.id)).importedFrom).toBeNull();
        yield* laptop.library.syncNow;
        expect((yield* roleOn(box.library, writer.id)).importers).toEqual([]);
      }),
  );

  it.effect("Also update on: an unedited copy takes the save on its next sync", () =>
    Effect.gen(function* () {
      const { laptop, box } = yield* twoMachines;
      const original = yield* box.library.createRole(writer);
      yield* laptop.library.importItems({
        ...nothing,
        sourceEnvironmentId: boxId,
        roleIds: [writer.id],
      });
      yield* laptop.library.syncNow;
      const saved = yield* box.library.updateRole({
        ...writer,
        instructions: "Pushed from the box.",
        expectedRevision: original.revision,
        enabled: true,
        alsoUpdateOn: [{ environmentId: laptopId, replacesEdits: false }],
      });
      expect(saved.importers).toMatchObject([{ environmentId: laptopId, pending: true }]);

      yield* laptop.library.syncNow;
      const taken = yield* roleOn(laptop.library, writer.id);
      expect(taken.instructions).toBe("Pushed from the box.");
      expect(libraryImportState(taken)).toEqual({ edited: false, updateAvailable: false });
      // Its next report clears the waiting update there.
      yield* laptop.library.syncNow;
      expect((yield* roleOn(box.library, writer.id)).importers).toMatchObject([
        { environmentId: laptopId, pending: false, edited: false, revision: saved.revision },
      ]);
    }),
  );

  it.effect("a copy edited after the source's person was asked is not overwritten", () =>
    Effect.gen(function* () {
      const { laptop, box } = yield* twoMachines;
      const original = yield* box.library.createRole(writer);
      yield* laptop.library.importItems({
        ...nothing,
        sourceEnvironmentId: boxId,
        roleIds: [writer.id],
      });
      yield* laptop.library.syncNow;
      // The box ticks the laptop while its copy is unedited, so nobody was warned.
      yield* box.library.updateRole({
        ...writer,
        instructions: "Pushed from the box.",
        expectedRevision: original.revision,
        enabled: true,
        alsoUpdateOn: [{ environmentId: laptopId, replacesEdits: false }],
      });
      const copy = yield* roleOn(laptop.library, writer.id);
      yield* laptop.library.updateRole({
        ...writer,
        instructions: "My own notes.",
        expectedRevision: copy.revision,
        enabled: true,
      });
      yield* laptop.library.syncNow;
      const kept = yield* roleOn(laptop.library, writer.id);
      expect(kept.instructions).toBe("My own notes.");
      expect(libraryImportState(kept)).toEqual({ edited: true, updateAvailable: true });
      expect((yield* roleOn(box.library, writer.id)).importers).toMatchObject([
        { edited: true, pending: false },
      ]);
    }),
  );

  it.effect("an edit saved while the sync is in flight is not overwritten by a pushed save", () =>
    Effect.gen(function* () {
      const { network, laptop, box } = yield* twoMachines;
      const original = yield* box.library.createRole(writer);
      yield* laptop.library.importItems({
        ...nothing,
        sourceEnvironmentId: boxId,
        roleIds: [writer.id],
      });
      yield* laptop.library.syncNow;
      yield* box.library.updateRole({
        ...writer,
        instructions: "Pushed from the box.",
        expectedRevision: original.revision,
        enabled: true,
        alsoUpdateOn: [{ environmentId: laptopId, replacesEdits: false }],
      });
      // The laptop's next sync waits at the box while the laptop saves an edit.
      const asked = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<void>();
      network.beforeAnswer.push(
        Deferred.succeed(asked, undefined).pipe(Effect.andThen(Deferred.await(answer))),
      );
      const syncing = yield* laptop.library.syncNow.pipe(Effect.forkChild);
      yield* Deferred.await(asked);
      const copy = yield* roleOn(laptop.library, writer.id);
      yield* laptop.library.updateRole({
        ...writer,
        instructions: "My own notes.",
        expectedRevision: copy.revision,
        enabled: true,
      });
      yield* Deferred.succeed(answer, undefined);
      yield* Fiber.join(syncing);

      const kept = yield* roleOn(laptop.library, writer.id);
      expect(kept.instructions).toBe("My own notes.");
      yield* laptop.library.syncNow;
      expect(libraryImportState(yield* roleOn(laptop.library, writer.id))).toEqual({
        edited: true,
        updateAvailable: true,
      });
    }),
  );

  it.effect("a save sent while an importer's sync is being answered still reaches it", () =>
    Effect.gen(function* () {
      const { network, laptop, box } = yield* twoMachines;
      const original = yield* box.library.createRole(writer);
      yield* laptop.library.importItems({
        ...nothing,
        sourceEnvironmentId: boxId,
        roleIds: [writer.id],
      });
      yield* laptop.library.syncNow;
      // The box is answering the laptop's sync, about to write what the laptop holds, when the
      // person there saves and sends it.
      const answering = yield* Deferred.make<void>();
      const write = yield* Deferred.make<void>();
      network.onTransaction.set(boxId, [
        Deferred.succeed(answering, undefined).pipe(Effect.andThen(Deferred.await(write))),
      ]);
      const syncing = yield* laptop.library.syncNow.pipe(Effect.forkChild);
      yield* Deferred.await(answering);
      yield* box.library.updateRole({
        ...writer,
        instructions: "Pushed from the box.",
        expectedRevision: original.revision,
        enabled: true,
        alsoUpdateOn: [{ environmentId: laptopId, replacesEdits: false }],
      });
      yield* Deferred.succeed(write, undefined);
      yield* Fiber.join(syncing);

      yield* laptop.library.syncNow;
      expect((yield* roleOn(laptop.library, writer.id)).instructions).toBe("Pushed from the box.");
    }),
  );

  it.effect("a save whose push is written late leaves a later save's targets alone", () =>
    Effect.gen(function* () {
      const { network, laptop, box } = yield* twoMachines;
      const original = yield* box.library.createRole(writer);
      yield* laptop.library.importItems({
        ...nothing,
        sourceEnvironmentId: boxId,
        roleIds: [writer.id],
      });
      yield* laptop.library.syncNow;
      // The first save commits, then waits before it records whom it was sent to.
      const committed = yield* Deferred.make<void>();
      const record = yield* Deferred.make<void>();
      network.onChange.set(boxId, [
        Deferred.succeed(committed, undefined).pipe(Effect.andThen(Deferred.await(record))),
      ]);
      const first = yield* box.library
        .updateRole({
          ...writer,
          instructions: "First, sent nowhere.",
          expectedRevision: original.revision,
          enabled: true,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(committed);
      const second = yield* box.library.updateRole({
        ...writer,
        instructions: "Second, sent to the laptop.",
        expectedRevision: original.revision + 1,
        enabled: true,
        alsoUpdateOn: [{ environmentId: laptopId, replacesEdits: false }],
      });
      yield* Deferred.succeed(record, undefined);
      yield* Fiber.join(first);

      expect((yield* roleOn(box.library, writer.id)).importers).toMatchObject([
        { environmentId: laptopId, pending: true },
      ]);
      expect(second.revision).toBe(original.revision + 2);
      yield* laptop.library.syncNow;
      expect((yield* roleOn(laptop.library, writer.id)).instructions).toBe(
        "Second, sent to the laptop.",
      );
    }),
  );

  it.effect("a save replaces edits only where the person was shown them", () =>
    Effect.gen(function* () {
      const { laptop, box } = yield* twoMachines;
      const original = yield* box.library.createRole(writer);
      yield* laptop.library.importItems({
        ...nothing,
        sourceEnvironmentId: boxId,
        roleIds: [writer.id],
      });
      yield* laptop.library.syncNow;
      // The box's dialog opens while the laptop's copy is unedited; then the laptop edits it
      // and syncs, so the box now knows, but the person saves what the dialog showed.
      const shown = (yield* roleOn(box.library, writer.id)).importers[0]!;
      expect(shown.edited).toBe(false);
      const copy = yield* roleOn(laptop.library, writer.id);
      yield* laptop.library.updateRole({
        ...writer,
        instructions: "My own notes.",
        expectedRevision: copy.revision,
        enabled: true,
      });
      yield* laptop.library.syncNow;
      expect((yield* roleOn(box.library, writer.id)).importers[0]?.edited).toBe(true);
      yield* box.library.updateRole({
        ...writer,
        instructions: "Pushed from the box.",
        expectedRevision: original.revision,
        enabled: true,
        alsoUpdateOn: [{ environmentId: laptopId, replacesEdits: shown.edited }],
      });
      yield* laptop.library.syncNow;
      expect((yield* roleOn(laptop.library, writer.id)).instructions).toBe("My own notes.");

      // Shown the edits and still ticked, the laptop takes it.
      const latest = (yield* box.crew.getRole(writer.id))!;
      yield* box.library.updateRole({
        ...writer,
        instructions: "Pushed again, knowingly.",
        expectedRevision: latest.revision,
        enabled: true,
        alsoUpdateOn: [{ environmentId: laptopId, replacesEdits: true }],
      });
      yield* laptop.library.syncNow;
      expect((yield* roleOn(laptop.library, writer.id)).instructions).toBe(
        "Pushed again, knowingly.",
      );
    }),
  );

  it.effect("a later save that doesn't tick a machine withdraws what waited for it", () =>
    Effect.gen(function* () {
      const { network, laptop, box } = yield* twoMachines;
      const original = yield* box.library.createRole(writer);
      yield* laptop.library.importItems({
        ...nothing,
        sourceEnvironmentId: boxId,
        roleIds: [writer.id],
      });
      yield* laptop.library.syncNow;
      network.offline.add(boxId);
      const second = yield* box.library.updateRole({
        ...writer,
        instructions: "Revision two, sent.",
        expectedRevision: original.revision,
        enabled: true,
        alsoUpdateOn: [{ environmentId: laptopId, replacesEdits: false }],
      });
      const third = yield* box.library.updateRole({
        ...writer,
        instructions: "Revision three, not sent.",
        expectedRevision: second.revision,
        enabled: true,
      });
      expect(third.importers).toMatchObject([{ pending: false }]);
      network.offline.delete(boxId);
      yield* laptop.library.syncNow;
      const copy = yield* roleOn(laptop.library, writer.id);
      expect(copy.instructions).toBe(writer.instructions);
      expect(libraryImportState(copy).updateAvailable).toBe(true);
    }),
  );

  it.effect("the same id needs replace, and what the importer gave never goes back to it", () =>
    Effect.gen(function* () {
      const { network, laptop, box } = yield* twoMachines;
      const planner = (yield* box.crew.getRole(PLANNER_ROLE_ID))!;
      yield* box.library.updateRole({
        ...planner,
        instructions: "The box's way to plan.",
        expectedRevision: planner.revision,
      });
      const declined = yield* laptop.library.importItems({
        ...nothing,
        sourceEnvironmentId: boxId,
        roleIds: [PLANNER_ROLE_ID],
      });
      expect(declined).toEqual({
        imported: [],
        skipped: [{ kind: "role", id: PLANNER_ROLE_ID, reason: "replaces" }],
      });
      yield* laptop.library.importItems({
        sourceEnvironmentId: boxId,
        roleIds: [PLANNER_ROLE_ID],
        workflowIds: [],
        replace: true,
      });
      expect((yield* laptop.crew.getRole(PLANNER_ROLE_ID))?.instructions).toBe(
        "The box's way to plan.",
      );

      // Linked back, the box's list from the laptop leaves out the Planner the laptop took.
      network.links.set(boxId, new Set([laptopId]));
      const fromLaptop = yield* box.library.importable(laptopId);
      expect(fromLaptop.items.some((item) => item.id === PLANNER_ROLE_ID)).toBe(false);
      expect(fromLaptop.items.some((item) => item.id === "role:builder")).toBe(true);
    }),
  );

  it.effect("problems show on the copy and never block editing; unlinking keeps imports", () =>
    Effect.gen(function* () {
      const { network, laptop, box } = yield* twoMachines;
      yield* box.library.createRole(writer);
      yield* laptop.library.importItems({
        ...nothing,
        sourceEnvironmentId: boxId,
        roleIds: [writer.id],
      });
      yield* laptop.library.syncNow;

      network.offline.add(boxId);
      yield* laptop.library.syncNow;
      expect((yield* roleOn(laptop.library, writer.id)).importedFrom?.problem).toBe("unreachable");
      network.offline.delete(boxId);

      network.older.add(boxId);
      expect((yield* laptop.library.importable(boxId)).problem).toBe("outdated");
      network.older.delete(boxId);

      yield* laptop.library.unlink(boxId);
      const kept = yield* roleOn(laptop.library, writer.id);
      expect(kept.importedFrom?.problem).toBe("notLinked");
      expect(libraryImportState(kept).updateAvailable).toBe(false);
      // The box heard the laptop holds nothing from it any more.
      expect((yield* roleOn(box.library, writer.id)).importers).toEqual([]);
      yield* laptop.library.updateRole({
        ...writer,
        instructions: "Still mine to edit.",
        expectedRevision: kept.revision,
        enabled: true,
      });
    }),
  );

  it.effect("a copy from before imports is current when it matches, and stale when not", () =>
    Effect.gen(function* () {
      const { laptop, box } = yield* twoMachines;
      const sourceRole = yield* box.library.createRole(writer);
      const migrated = {
        environmentId: boxId,
        label: "Box",
        revision: null,
        localRevision: 1,
        available: null,
        skipped: null,
        problem: null,
      };
      const at = "2026-11-27T00:00:00.000Z";
      yield* laptop.store.insertRole({
        ...writer,
        fallbackModelSelection: null,
        enabled: true,
        importedFrom: migrated,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      });
      yield* laptop.library.syncNow;
      expect((yield* roleOn(laptop.library, writer.id)).importedFrom).toMatchObject({
        revision: sourceRole.revision,
        available: null,
      });

      yield* laptop.store.setImportedFrom("role", writer.id, migrated);
      yield* box.library.updateRole({
        ...writer,
        instructions: "Changed since the copy.",
        expectedRevision: sourceRole.revision,
        enabled: true,
      });
      yield* laptop.library.syncNow;
      expect(libraryImportState(yield* roleOn(laptop.library, writer.id)).updateAvailable).toBe(
        true,
      );
    }),
  );
});
