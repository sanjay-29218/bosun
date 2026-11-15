// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CrewOperationError,
  EPIC_WORKFLOW_ID,
  FEATURE_DELIVERY_WORKFLOW_ID,
  type LibraryOwner,
  OrchestratorMcpFailure,
  type WorkflowShare,
  WorkflowShareClash,
  WorkflowShareRoleChoice,
  type WorkflowShareSetInput,
  type WorkflowShareSetResult,
  type WorkflowSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { Tool } from "effect/ai";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { FeatureService } from "../features/FeatureService.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { LinkWorkflowSync } from "../mcp/toolkits/bots/linkTools.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { crewChangeNotifier } from "./CrewChanges.ts";
import { CrewService } from "./CrewService.ts";

type SyncInput = Tool.Parameters<typeof LinkWorkflowSync>;
type SyncResult = Tool.Success<typeof LinkWorkflowSync>;
type RoleChoices = Readonly<Record<string, WorkflowShareRoleChoice>>;

/** One asleep machine shows as unreachable instead of holding up the others. */
const LINK_TIMEOUT = Duration.seconds(15);

/**
 * Workflows shared with linked environments. The environment that owns a workflow pushes it, and
 * the roles it uses, to each environment it is ticked for, because links reach one way only: a
 * linked environment can't call back. `sync` runs whenever the Library changes and each minute,
 * so a copy on a machine that was off catches up when it answers again.
 */
export class WorkflowSharing extends Context.Service<
  WorkflowSharing,
  {
    /** Where workflow `workflowId` is shared or being removed, and how each copy stands. */
    readonly shares: (
      workflowId: string,
    ) => Effect.Effect<ReadonlyArray<WorkflowShare>, CrewOperationError>;
    /**
     * Shares the workflow with a linked environment, records role choices, or stops sharing it.
     * Stopping first asks there for open features that follow it, and while there are some
     * changes nothing unless `confirmed`; a machine that doesn't answer loses it when it's back.
     */
    readonly setShare: (
      input: WorkflowShareSetInput,
    ) => Effect.Effect<WorkflowShareSetResult, CrewOperationError>;
    /**
     * Brings every linked environment that answers up to date with what's shared with it. The
     * server runs it after each Library change, which `setShare` reports, and each minute.
     */
    readonly sync: Effect.Effect<void>;
    /** For a linked environment that shares a workflow here: puts it, removes it, or reports. */
    readonly receive: (
      scope: McpInvocationContext.McpInvocationScope,
      input: SyncInput,
    ) => Effect.Effect<SyncResult, OrchestratorMcpFailure>;
  }
>()("t3/crew/WorkflowSharing") {}

interface ShareRow {
  readonly workflowId: string;
  readonly environmentId: string;
  readonly label: string;
  readonly shared: number;
  readonly roleChoicesJson: string;
  readonly pushedDigest: string | null;
  readonly syncedAt: string | null;
  readonly clashesJson: string;
  readonly lastError: string | null;
}

const RoleChoicesJson = Schema.fromJsonString(
  Schema.Record(Schema.String, WorkflowShareRoleChoice),
);
const ClashesJson = Schema.fromJsonString(Schema.Array(WorkflowShareClash));
const encodeRoleChoices = Schema.encodeEffect(RoleChoicesJson);
const encodeClashes = Schema.encodeEffect(ClashesJson);
const decodeRoleChoices = Schema.decodeUnknownOption(RoleChoicesJson);
const decodeClashes = Schema.decodeUnknownOption(ClashesJson);

/** Key order doesn't matter: model options arrive from JSON in any order. */
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([left], [right]) => left.localeCompare(right)),
        )
      : item,
  );

/** What a copy there was last brought up to: the workflow, its roles and the choices for them. */
const digestOf = (snapshot: WorkflowSnapshot, roleChoices: RoleChoices) =>
  NodeCrypto.createHash("sha256").update(stableJson({ snapshot, roleChoices })).digest("hex");

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const operationError = (error: { readonly message: string }) =>
  new CrewOperationError({ reason: error.message });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crew = yield* CrewService;
  const features = yield* FeatureService;
  const links = yield* PeerLinks.PeerLinks;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const { notify } = yield* crewChangeNotifier;
  const syncing = yield* Semaphore.make(1);

  const here = environment.getDescriptor.pipe(
    Effect.map((descriptor): LibraryOwner => ({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
    })),
  );

  /** How sync reaches a linked environment: as this environment, with no thread of its own. */
  const syncScope = (self: LibraryOwner): McpInvocationContext.McpInvocationScope => ({
    environmentId: self.environmentId,
    requestNamespace: "workflow-sharing",
    thread: undefined,
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });

  const call = (self: LibraryOwner, environmentId: string, input: SyncInput) =>
    forwarding.call(syncScope(self), LinkWorkflowSync, environmentId as never, input).pipe(
      Effect.timeoutOrElse({
        duration: LINK_TIMEOUT,
        orElse: () =>
          Effect.fail(
            failure(
              "orchestration_error",
              `Didn't answer within ${Duration.toSeconds(LINK_TIMEOUT)} s.`,
            ),
          ),
      }),
    );

  const rowsOf = (workflowId: string | null) =>
    sql<ShareRow>`
      SELECT workflow_id AS workflowId, environment_id AS environmentId, label, shared,
        role_choices_json AS roleChoicesJson, pushed_digest AS pushedDigest,
        synced_at AS syncedAt, clashes_json AS clashesJson, last_error AS lastError
      FROM workflow_shares
      ${workflowId === null ? sql`` : sql`WHERE workflow_id = ${workflowId}`}
      ORDER BY workflow_id, label, environment_id
    `;

  const choicesOf = (row: ShareRow): RoleChoices =>
    Option.getOrElse(decodeRoleChoices(row.roleChoicesJson), () => ({}));

  const syncRow = Effect.fn("WorkflowSharing.syncRow")(function* (
    self: LibraryOwner,
    row: ShareRow,
  ) {
    // A workflow deleted here goes there too.
    const snapshot = row.shared === 1 ? yield* crew.workflowSnapshot(row.workflowId) : null;
    const roleChoices = choicesOf(row);
    const digest = snapshot === null ? null : digestOf(snapshot, roleChoices);
    if (digest !== null && digest === row.pushedDigest) return false;
    const answered = yield* call(self, row.environmentId, {
      owner: self,
      workflowId: row.workflowId,
      snapshot,
      roleChoices,
    }).pipe(Effect.result);
    if (answered._tag === "Failure") {
      if (answered.failure.message === row.lastError) return false;
      yield* sql`
        UPDATE workflow_shares SET last_error = ${answered.failure.message}
        WHERE workflow_id = ${row.workflowId} AND environment_id = ${row.environmentId}
      `;
      return true;
    }
    if (snapshot === null) {
      yield* sql`
        DELETE FROM workflow_shares
        WHERE workflow_id = ${row.workflowId} AND environment_id = ${row.environmentId}
      `;
      return true;
    }
    const { clashes } = answered.success;
    // Nothing changed there while a clash waits, so the copy is as old as its last sync.
    const syncedAt = clashes.length === 0 ? DateTime.formatIso(yield* DateTime.now) : row.syncedAt;
    yield* sql`
      UPDATE workflow_shares SET pushed_digest = ${digest}, synced_at = ${syncedAt},
        clashes_json = ${yield* encodeClashes(clashes)}, last_error = NULL
      WHERE workflow_id = ${row.workflowId} AND environment_id = ${row.environmentId}
    `;
    return true;
  });

  const sync: WorkflowSharing["Service"]["sync"] = syncing
    .withPermits(1)(
      Effect.gen(function* () {
        const rows = yield* rowsOf(null);
        if (rows.length === 0 || !(yield* links.enabled)) return;
        const reachable = new Set(
          (yield* links.list.pipe(Effect.orElseSucceed(() => [])))
            .filter((link) => link.status === "reachable")
            .map((link) => link.environmentId as string),
        );
        const self = yield* here;
        let changed = false;
        for (const row of rows) {
          // An unlinked or asleep machine keeps its row and catches up once it answers.
          if (!reachable.has(row.environmentId)) continue;
          if (yield* syncRow(self, row)) changed = true;
        }
        if (changed) yield* notify("library");
      }),
    )
    .pipe(
      Effect.catchCause((cause) => Effect.logWarning("Syncing shared workflows failed", { cause })),
      Effect.withSpan("WorkflowSharing.sync"),
    );

  const shares: WorkflowSharing["Service"]["shares"] = Effect.fn("WorkflowSharing.shares")(
    function* (workflowId) {
      const rows = yield* rowsOf(workflowId);
      const snapshot = yield* crew.workflowSnapshot(workflowId);
      return rows.map((row): WorkflowShare => {
        const roleChoices = choicesOf(row);
        const clashes = Option.getOrElse(decodeClashes(row.clashesJson), () => []);
        const current = snapshot !== null && row.pushedDigest === digestOf(snapshot, roleChoices);
        return {
          environmentId: row.environmentId as WorkflowShare["environmentId"],
          label: row.label,
          shared: row.shared === 1,
          state:
            row.shared !== 1
              ? "removing"
              : !current
                ? "pending"
                : clashes.length > 0
                  ? "clash"
                  : "synced",
          syncedAt: row.syncedAt,
          error: row.lastError,
          clashes: current ? clashes : [],
          roleChoices,
        };
      });
    },
    Effect.mapError(operationError),
  );

  const setShare: WorkflowSharing["Service"]["setShare"] = Effect.fn("WorkflowSharing.setShare")(
    function* (input) {
      const refuse = (reason: string) => Effect.fail(new CrewOperationError({ reason }));
      const [existing] = yield* sql<ShareRow>`
        SELECT workflow_id AS workflowId, environment_id AS environmentId, label, shared,
          role_choices_json AS roleChoicesJson, pushed_digest AS pushedDigest,
          synced_at AS syncedAt, clashes_json AS clashesJson, last_error AS lastError
        FROM workflow_shares
        WHERE workflow_id = ${input.workflowId} AND environment_id = ${input.environmentId}
      `;
      const link = Option.getOrUndefined(
        yield* links.get(input.environmentId).pipe(Effect.orElseSucceed(() => Option.none())),
      );
      if (!input.shared) {
        if (existing === undefined) return { applied: true, openFeatures: [] };
        // Asked first, so a person hears what still runs on it there.
        if (input.confirmed !== true && link !== undefined) {
          const self = yield* here;
          const status = yield* call(self, input.environmentId, {
            owner: self,
            workflowId: input.workflowId,
          }).pipe(Effect.option);
          if (Option.isSome(status) && status.value.openFeatures.length > 0) {
            return { applied: false, openFeatures: status.value.openFeatures };
          }
        }
        // Never linked any more, so there's nothing to remove there.
        if (link === undefined) {
          yield* sql`
            DELETE FROM workflow_shares
            WHERE workflow_id = ${input.workflowId} AND environment_id = ${input.environmentId}
          `;
        } else {
          yield* sql`
            UPDATE workflow_shares SET shared = 0, last_error = NULL, clashes_json = '[]'
            WHERE workflow_id = ${input.workflowId} AND environment_id = ${input.environmentId}
          `;
        }
        yield* notify("library");
        return { applied: true, openFeatures: [] };
      }
      if (!(yield* links.enabled)) {
        return yield* refuse("Linked environments are off here. Turn them on in Settings → Labs.");
      }
      const workflow = yield* crew.getWorkflow(input.workflowId);
      if (workflow === null) return yield* refuse(`Workflow not found: ${input.workflowId}`);
      if (workflow.managedBy !== null) {
        return yield* refuse(
          `${workflow.name} is managed from ${workflow.managedBy.label}. Share it from there.`,
        );
      }
      // Every machine has its own; one shared over it couldn't be removed without losing it there.
      if (workflow.id === FEATURE_DELIVERY_WORKFLOW_ID || workflow.id === EPIC_WORKFLOW_ID) {
        return yield* refuse(
          `Every machine has its own ${workflow.name}. Share a workflow you made instead.`,
        );
      }
      if (link === undefined) {
        return yield* refuse(`${input.label} isn't linked to this machine any more.`);
      }
      const roleChoices = yield* encodeRoleChoices(
        input.roleChoices ?? (existing === undefined ? {} : choicesOf(existing)),
      );
      yield* sql`
        INSERT INTO workflow_shares (workflow_id, environment_id, label, shared, role_choices_json)
        VALUES (${input.workflowId}, ${input.environmentId}, ${link.label}, 1, ${roleChoices})
        ON CONFLICT (workflow_id, environment_id) DO UPDATE SET
          label = excluded.label, shared = 1, role_choices_json = excluded.role_choices_json
      `;
      yield* notify("library");
      return { applied: true, openFeatures: [] };
    },
    Effect.mapError((error) =>
      error._tag === "CrewOperationError" ? error : operationError(error),
    ),
  );

  const receive: WorkflowSharing["Service"]["receive"] = Effect.fn("WorkflowSharing.receive")(
    function* (callerScope, input) {
      const self = yield* here;
      const client = callerScope.client;
      if (client?.linked !== true) {
        return yield* failure(
          "capability_denied",
          "Only a linked environment shares its workflows here this way.",
        );
      }
      let clashes: ReadonlyArray<WorkflowShareClash> = [];
      if (input.snapshot !== undefined) {
        // Library changes from a link are fenced below full access, like its project work.
        if (client.access !== "full-access") {
          return yield* failure(
            "capability_denied",
            `${self.label} is linked with ${client.access} access, and sharing a workflow there needs full access. Link ${self.label} again with full access in Settings → Environments → Linked environments.`,
          );
        }
        if (input.snapshot !== null && input.snapshot.workflow.id !== input.workflowId) {
          return yield* failure("invalid_request", "The workflow sent isn't the one named.");
        }
        clashes = (yield* crew
          .receiveSharedWorkflow({
            owner: input.owner,
            workflowId: input.workflowId,
            snapshot: input.snapshot,
            roleChoices: input.roleChoices ?? {},
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                error._tag === "CrewValidationError" ? "invalid_request" : "orchestration_error",
                error.message,
              ),
            ),
          )).clashes;
      }
      const openFeatures = yield* features
        .listOpenByWorkflow(input.workflowId)
        .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
      return { clashes, openFeatures };
    },
  );

  return WorkflowSharing.of({ shares, setShare, sync, receive });
});

export const layer = Layer.effect(WorkflowSharing, make);
