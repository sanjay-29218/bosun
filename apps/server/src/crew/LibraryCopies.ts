import {
  type EnvironmentId,
  type LibraryCopy,
  type LibraryOwner,
  type OrchestratorMcpFailure,
  type PeerLinkError,
  type RoleConfig,
  type RoleCreateInput,
  type RoleUpdateInput,
  type WorkflowConfig,
  type WorkflowCreateInput,
  type WorkflowUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { type LibraryCopySet, LinkLibrary } from "../mcp/toolkits/bots/linkTools.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { crewChangeNotifier } from "./CrewChanges.ts";
import { CrewService, type CrewServiceError } from "./CrewService.ts";
import type { Role, Workflow } from "./CrewStore.ts";

type Kind = "workflow" | "role";
export type LibraryError = CrewServiceError | PersistenceSqlError;

/** A machine that was off catches up within this long of answering again. */
const CATCH_UP_INTERVAL = Duration.minutes(1);
/** One asleep machine doesn't hold up the others. */
const PUSH_TIMEOUT = Duration.seconds(15);

interface CopyRow {
  readonly environmentId: EnvironmentId;
  readonly kind: string;
  readonly itemId: string;
  readonly deliveredRevision: number | null;
  readonly deliveredAt: string | null;
  readonly problem: string | null;
}

/**
 * Every workflow and role this machine made, copied to every machine it links to over the peer
 * link. The machine that made one owns it, and the copies are read-only. Each machine is sent
 * the whole set, so a deleted one goes there too, a machine that was off catches up when it
 * answers again, and unlinking sends it an empty set first. Copies are never copied on.
 */
export class LibraryCopies extends Context.Service<
  LibraryCopies,
  {
    readonly listRoles: Effect.Effect<ReadonlyArray<RoleConfig>, LibraryError>;
    readonly listWorkflows: Effect.Effect<ReadonlyArray<WorkflowConfig>, LibraryError>;
    readonly createRole: (
      input: typeof RoleCreateInput.Type,
    ) => Effect.Effect<RoleConfig, LibraryError>;
    readonly updateRole: (
      input: typeof RoleUpdateInput.Type,
    ) => Effect.Effect<RoleConfig, LibraryError>;
    readonly createWorkflow: (
      input: typeof WorkflowCreateInput.Type,
    ) => Effect.Effect<WorkflowConfig, LibraryError>;
    readonly updateWorkflow: (
      input: typeof WorkflowUpdateInput.Type,
    ) => Effect.Effect<WorkflowConfig, LibraryError>;
    readonly deleteWorkflow: (id: string) => Effect.Effect<void, LibraryError>;
    /**
     * Removes this machine's copies from `environmentId` while it answers, then unlinks it. A
     * machine that doesn't answer keeps them; it is unlinked either way.
     */
    readonly unlink: (environmentId: EnvironmentId) => Effect.Effect<boolean, PeerLinkError>;
    /** Sends each linked machine the set when it changed since that machine last took one. */
    readonly push: Effect.Effect<void>;
    /** Pushes after every save, and each minute for machines that were off. */
    readonly run: Effect.Effect<never>;
  }
>()("t3/crew/LibraryCopies") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crew = yield* CrewService;
  const links = yield* PeerLinks.PeerLinks;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Digest.Digest;
  const saved = yield* Queue.sliding<void>(1);
  const pushing = yield* Semaphore.make(1);
  const queryError = toPersistenceSqlError("LibraryCopies");
  // What each machine got shows in the library, so clients re-read it.
  const { notify } = yield* crewChangeNotifier;

  const copyRows = sql<CopyRow>`
    SELECT environment_id AS environmentId, kind, item_id AS itemId,
      delivered_revision AS deliveredRevision, delivered_at AS deliveredAt, problem
    FROM library_copies ORDER BY environment_id
  `.pipe(Effect.mapError(queryError));

  const linkedIds = links.list.pipe(
    Effect.map((linked) => new Set(linked.map((link) => link.environmentId))),
    Effect.orElseSucceed(() => new Set<EnvironmentId>()),
  );

  /** Where this machine's own one is, on the machines linked now. A copy lists none. */
  const withCopies = <T extends Role | Workflow>(
    kind: Kind,
    item: T,
    rows: ReadonlyArray<CopyRow>,
    linked: ReadonlySet<EnvironmentId>,
  ) => ({
    ...item,
    copies:
      item.managedFrom === null
        ? rows
            .filter(
              (row) => row.kind === kind && row.itemId === item.id && linked.has(row.environmentId),
            )
            .map((row): LibraryCopy => ({
              environmentId: row.environmentId,
              deliveredRevision: row.deliveredRevision,
              deliveredAt: row.deliveredAt,
              problem: row.problem,
            }))
        : [],
  });

  const listRoles: LibraryCopies["Service"]["listRoles"] = Effect.gen(function* () {
    const rows = yield* copyRows;
    const linked = yield* linkedIds;
    return (yield* crew.listRoles()).map((role) => withCopies("role", role, rows, linked));
  }).pipe(Effect.withSpan("LibraryCopies.listRoles"));

  const listWorkflows: LibraryCopies["Service"]["listWorkflows"] = Effect.gen(function* () {
    const rows = yield* copyRows;
    const linked = yield* linkedIds;
    return (yield* crew.listWorkflows()).map((workflow) =>
      withCopies("workflow", workflow, rows, linked),
    );
  }).pipe(Effect.withSpan("LibraryCopies.listWorkflows"));

  /** After a save, every linked machine gets it within seconds. */
  const withSaved = <A extends Role | Workflow>(kind: Kind, item: A) =>
    Queue.offer(saved, undefined).pipe(
      Effect.andThen(Effect.all([copyRows, linkedIds])),
      Effect.map(([rows, linked]) => withCopies(kind, item, rows, linked)),
    );

  /**
   * What every linked machine gets from here: each workflow and role made here, never one
   * copied from elsewhere.
   */
  const ownSet = Effect.fn("LibraryCopies.ownSet")(function* (owner: LibraryOwner) {
    const workflows = (yield* crew.listWorkflows()).filter((item) => item.managedFrom === null);
    const roles = (yield* crew.listRoles()).filter((item) => item.managedFrom === null);
    const set: LibraryCopySet = {
      owner,
      workflows: workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        instructions: workflow.instructions,
        leadRoleId: workflow.leadRoleId,
        crewRoleIds: workflow.crewRoleIds,
        revision: workflow.revision,
      })),
      roles: roles.map((role) => ({
        id: role.id,
        name: role.name,
        instructions: role.instructions,
        modelSelection: role.modelSelection,
        enabled: role.enabled,
      })),
    };
    const items = [
      ...workflows.map((workflow) => ({
        kind: "workflow" as const,
        id: workflow.id,
        revision: workflow.revision,
      })),
      ...roles.map((role) => ({ kind: "role" as const, id: role.id, revision: role.revision })),
    ];
    return { set, items };
  });

  const hashOf = (set: LibraryCopySet) =>
    crypto
      .digest(Digest.sha256, new TextEncoder().encode(JSON.stringify(set)))
      .pipe(Effect.map(Hex.encode), Effect.orDie);

  /** How a push reaches a linked machine: as this server, not any agent's thread. */
  const pushScope = (environmentId: EnvironmentId): McpInvocationContext.McpInvocationScope => ({
    environmentId,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
    requestNamespace: "library-copies",
    thread: undefined,
    client: undefined,
  });

  const self = environment.getDescriptor.pipe(
    Effect.map((descriptor): LibraryOwner => ({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
    })),
  );

  /**
   * Its answer; or no answer, with why when it refused copies outright. An
   * `orchestration_error` is a machine that's off or busy, which may pass later.
   */
  const send = (owner: LibraryOwner, environmentId: EnvironmentId, set: LibraryCopySet) =>
    forwarding.call(pushScope(owner.environmentId), LinkLibrary, environmentId, set).pipe(
      Effect.timeoutOrElse({ duration: PUSH_TIMEOUT, orElse: () => Effect.succeed(null) }),
      Effect.map((answered) => ({ answered, refusal: null })),
      Effect.catch((error: OrchestratorMcpFailure) =>
        Effect.succeed({
          answered: null,
          refusal: error.code === "orchestration_error" ? null : error.message,
        }),
      ),
    );

  const pushTo = Effect.fn("LibraryCopies.pushTo")(function* (
    environmentId: EnvironmentId,
    owner: LibraryOwner,
  ) {
    const { set, items } = yield* ownSet(owner);
    const hash = yield* hashOf(set);
    const [last] = yield* sql<{ readonly hash: string }>`
      SELECT delivered_hash AS hash FROM library_copy_peers WHERE environment_id = ${environmentId}
    `.pipe(Effect.mapError(queryError));
    if (last?.hash === hash) return;
    const { answered, refusal } = yield* send(owner, environmentId, set);
    if (answered === null && refusal === null) return;
    const now = DateTime.formatIso(yield* DateTime.now);
    const reasonFor = (item: (typeof items)[number]) =>
      refusal ??
      answered?.refused.find(
        (candidate) => candidate.kind === item.kind && candidate.id === item.id,
      )?.reason ??
      null;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const kept = new Set(items.map((item) => `${item.kind}\n${item.id}`));
          for (const row of yield* copyRows) {
            if (row.environmentId === environmentId && !kept.has(`${row.kind}\n${row.itemId}`)) {
              yield* sql`
                DELETE FROM library_copies WHERE environment_id = ${environmentId}
                  AND kind = ${row.kind} AND item_id = ${row.itemId}
              `;
            }
          }
          for (const item of items) {
            const reason = reasonFor(item);
            // One kept back there keeps the revision it last had there, if any.
            yield* reason === null
              ? sql`
                  INSERT INTO library_copies
                    (environment_id, kind, item_id, delivered_revision, delivered_at, problem)
                  VALUES (${environmentId}, ${item.kind}, ${item.id}, ${item.revision}, ${now}, NULL)
                  ON CONFLICT (environment_id, kind, item_id) DO UPDATE SET
                    delivered_revision = excluded.delivered_revision,
                    delivered_at = excluded.delivered_at, problem = NULL
                `
              : sql`
                  INSERT INTO library_copies (environment_id, kind, item_id, problem)
                  VALUES (${environmentId}, ${item.kind}, ${item.id}, ${reason})
                  ON CONFLICT (environment_id, kind, item_id) DO UPDATE SET
                    problem = excluded.problem
                `;
          }
          // A machine that kept anything back is asked again, in case it no longer does.
          if (refusal !== null || (answered?.refused.length ?? 0) > 0) return;
          yield* sql`
            INSERT INTO library_copy_peers (environment_id, delivered_hash, delivered_at)
            VALUES (${environmentId}, ${hash}, ${now})
            ON CONFLICT (environment_id) DO UPDATE SET
              delivered_hash = excluded.delivered_hash, delivered_at = excluded.delivered_at
          `;
        }),
      )
      .pipe(Effect.mapError(queryError));
    yield* notify("library");
  });

  const push: LibraryCopies["Service"]["push"] = pushing
    .withPermits(1)(
      Effect.gen(function* () {
        // With Linked environments off here, nothing goes out and nothing is marked failed.
        if (!(yield* links.enabled)) return;
        const owner = yield* self;
        const linked = yield* links.list.pipe(Effect.orElseSucceed(() => []));
        yield* Effect.forEach(
          linked,
          (link) =>
            pushTo(link.environmentId, owner).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Copying workflows to a linked machine failed", {
                  environmentId: link.environmentId,
                  cause,
                }),
              ),
            ),
          { concurrency: 4, discard: true },
        );
      }),
    )
    .pipe(Effect.withSpan("LibraryCopies.push"));

  const unlink: LibraryCopies["Service"]["unlink"] = Effect.fn("LibraryCopies.unlink")(
    function* (environmentId) {
      // Held through the unlink, so no push re-sends the copies in between.
      return yield* pushing.withPermits(1)(
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const owner = yield* self;
            const { answered } = yield* send(owner, environmentId, {
              owner,
              workflows: [],
              roles: [],
            });
            if (answered === null) {
              yield* Effect.logInfo("An unlinked machine keeps this machine's copies", {
                environmentId,
              });
            }
            yield* sql`DELETE FROM library_copies WHERE environment_id = ${environmentId}`;
            yield* sql`DELETE FROM library_copy_peers WHERE environment_id = ${environmentId}`;
          }).pipe(Effect.ignoreCause({ log: true }));
          return yield* links.unlink(environmentId);
        }),
      );
    },
  );

  const run: LibraryCopies["Service"]["run"] = Effect.forever(
    push.pipe(
      Effect.andThen(
        Queue.take(saved).pipe(
          Effect.timeoutOrElse({ duration: CATCH_UP_INTERVAL, orElse: () => Effect.void }),
        ),
      ),
    ),
  );

  return LibraryCopies.of({
    listRoles,
    listWorkflows,
    createRole: Effect.fn("LibraryCopies.createRole")(function* (input) {
      return yield* withSaved("role", yield* crew.createRole(input));
    }),
    updateRole: Effect.fn("LibraryCopies.updateRole")(function* (input) {
      return yield* withSaved("role", yield* crew.updateRole(input));
    }),
    createWorkflow: Effect.fn("LibraryCopies.createWorkflow")(function* (input) {
      return yield* withSaved("workflow", yield* crew.createWorkflow(input));
    }),
    updateWorkflow: Effect.fn("LibraryCopies.updateWorkflow")(function* (input) {
      return yield* withSaved("workflow", yield* crew.updateWorkflow(input));
    }),
    deleteWorkflow: Effect.fn("LibraryCopies.deleteWorkflow")(function* (id) {
      yield* crew.deleteWorkflow(id);
      yield* Queue.offer(saved, undefined);
    }),
    unlink,
    push,
    run,
  });
});

export const layer = Layer.effect(LibraryCopies, make);

/**
 * Unlinks `environmentId`, through `LibraryCopies` where this server runs it so its copies there
 * go first. Upstream's link tools and their tests run without it.
 */
export const unlinkEnvironment = (environmentId: EnvironmentId) =>
  Effect.serviceOption(LibraryCopies).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          PeerLinks.PeerLinks.pipe(Effect.flatMap((links) => links.unlink(environmentId))),
        onSome: (copies) => copies.unlink(environmentId),
      }),
    ),
  );
