import {
  type EnvironmentId,
  type ImportedFrom,
  type LibraryDetachInput,
  type LibraryImportable,
  type LibraryImportableItem,
  type LibraryImporter,
  type LibraryImportInput,
  LibraryImportProblem,
  type LibraryImportResult,
  type LibraryItemKind,
  type LibraryPushTarget,
  OrchestratorMcpFailure,
  type RoleConfig,
  type RoleCreateInput,
  type RoleUpdateInput,
  type WorkflowConfig,
  type WorkflowCreateInput,
  type WorkflowUpdateInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import {
  type LibraryItemContent,
  LinkLibrarySync,
  type LibrarySyncInput,
  type LibrarySyncResult,
} from "../mcp/toolkits/bots/linkTools.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { crewChangeNotifier } from "./CrewChanges.ts";
import { CrewService, type CrewServiceError, CrewValidationError, isStock } from "./CrewService.ts";
import { CrewStore, type Role, type Workflow } from "./CrewStore.ts";

export type LibraryError = CrewServiceError | PersistenceSqlError;

/** How often an importer asks its sources, besides whenever the library is opened. */
const SYNC_INTERVAL = Duration.minutes(1);
/** Opening the library asks again only when the last sync is older than this. */
const SYNC_ON_OPEN_AFTER_MS = 15_000;
/** One asleep machine doesn't hold up the others. */
const CALL_TIMEOUT = Duration.seconds(15);

type Item =
  | { readonly kind: "role"; readonly item: Role }
  | { readonly kind: "workflow"; readonly item: Workflow };

interface ImporterRow {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly kind: string;
  readonly itemId: string;
  readonly revision: number | null;
  readonly edited: number;
  readonly pushRevision: number | null;
  readonly pushOverwrites: number;
  readonly seenAt: string;
}

class SourceProblem extends Schema.TaggedError<SourceProblem>()("SourceProblem", {
  problem: LibraryImportProblem,
}) {}

const keyOf = (kind: string, id: string) => `${kind}\n${id}`;

const sameImportedFrom = (left: ImportedFrom, right: ImportedFrom | null) =>
  right !== null &&
  left.environmentId === right.environmentId &&
  left.label === right.label &&
  left.revision === right.revision &&
  left.localRevision === right.localRevision &&
  left.available === right.available &&
  left.skipped === right.skipped &&
  left.problem === right.problem;

const editedHere = (item: Role | Workflow) =>
  item.importedFrom !== null && item.revision !== item.importedFrom.localRevision;

const contentOf = (entry: Item): LibraryItemContent =>
  entry.kind === "role"
    ? {
        name: entry.item.name,
        instructions: entry.item.instructions,
        modelSelection: entry.item.modelSelection,
        fallbackModelSelection: entry.item.fallbackModelSelection,
        enabled: entry.item.enabled,
      }
    : {
        name: entry.item.name,
        instructions: entry.item.instructions,
        crewRoleIds: entry.item.crewRoleIds,
      };

/** Whether content a source sent matches this one, leaving out whether a role is on. */
const sameContent = (entry: Item, content: LibraryItemContent) => {
  const fields = (item: LibraryItemContent) =>
    entry.kind === "role"
      ? [item.name, item.instructions, item.modelSelection, item.fallbackModelSelection ?? null]
      : [item.name, item.instructions, item.crewRoleIds ?? []];
  return JSON.stringify(fields(contentOf(entry))) === JSON.stringify(fields(content));
};

const problemOf = (error: OrchestratorMcpFailure): LibraryImportProblem =>
  /Tool '?t3_crew_link_library_sync'? not found/.test(error.message)
    ? "outdated"
    : error.code === "capability_denied"
      ? "denied"
      : "unreachable";

const problemText = (problem: LibraryImportProblem, label: string) => {
  switch (problem) {
    case "unreachable":
      return `${label} didn't answer. Try again when it's on.`;
    case "expired":
      return `The link to ${label} expired. Link it again.`;
    case "denied":
      return `Importing from ${label} needs a full-access link. Link it again with full access.`;
    case "outdated":
      return `Update Bosun on ${label} to import from it.`;
    case "notLinked":
      return `Link ${label} first to import from it.`;
    case "removed":
      return `${label} no longer has it.`;
  }
};

/**
 * Workflows and roles imported from linked machines, editable and remembering their source.
 * Links are one-way, so the importer does all the asking, and each source learns who imported
 * what only from those reports.
 */
export class LibraryImports extends Context.Service<
  LibraryImports,
  {
    readonly listRoles: Effect.Effect<ReadonlyArray<RoleConfig>, LibraryError>;
    readonly listWorkflows: Effect.Effect<ReadonlyArray<WorkflowConfig>, LibraryError>;
    readonly createRole: (
      input: typeof RoleCreateInput.Type,
    ) => Effect.Effect<RoleConfig, LibraryError>;
    /** Saves it; `alsoUpdateOn` importers take this save on their next sync. */
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
    /** What a linked machine has that this one could import, and what each would do here. */
    readonly importable: (
      sourceEnvironmentId: EnvironmentId,
    ) => Effect.Effect<LibraryImportable, LibraryError>;
    /** Imports, or takes the update of ones that came from there. */
    readonly importItems: (
      input: typeof LibraryImportInput.Type,
    ) => Effect.Effect<LibraryImportResult, LibraryError>;
    readonly detach: (input: typeof LibraryDetachInput.Type) => Effect.Effect<void, LibraryError>;
    /** For an importer's link: records what it holds and answers what changed here. */
    readonly serveSync: (
      scope: McpInvocationContext.McpInvocationScope,
      input: LibrarySyncInput,
    ) => Effect.Effect<LibrarySyncResult, OrchestratorMcpFailure>;
    /**
     * Tells `environmentId` this machine holds nothing from it any more while it answers, then
     * unlinks it. Imports from it stay, without updates until it is linked again.
     */
    readonly unlink: PeerLinks.PeerLinks["Service"]["unlink"];
    readonly syncNow: Effect.Effect<void>;
    /** Syncs each minute, and soon after the library is opened. */
    readonly run: Effect.Effect<never>;
  }
>()("t3/crew/LibraryImports") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crew = yield* CrewService;
  const store = yield* CrewStore;
  const links = yield* PeerLinks.PeerLinks;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const wake = yield* Queue.sliding<void>(1);
  const writing = yield* Semaphore.make(1);
  const lastSyncAt = yield* Ref.make(0);
  /** Sources this machine stopped holding anything from, which still list it as an importer. */
  const forgotten = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());
  const queryError = toPersistenceSqlError("LibraryImports");
  const { notify } = yield* crewChangeNotifier;

  const self = environment.getDescriptor.pipe(
    Effect.map((descriptor) => ({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
    })),
  );

  const importerRows = sql<ImporterRow>`
    SELECT environment_id AS environmentId, label, kind, item_id AS itemId, revision, edited,
      push_revision AS pushRevision, push_overwrites AS pushOverwrites, seen_at AS seenAt
    FROM library_importers ORDER BY label, environment_id
  `.pipe(Effect.mapError(queryError));

  const importersOf = (rows: ReadonlyArray<ImporterRow>, kind: LibraryItemKind, id: string) =>
    rows
      .filter((row) => row.kind === kind && row.itemId === id)
      .map((row): LibraryImporter => ({
        environmentId: row.environmentId,
        label: row.label,
        revision: row.revision,
        edited: row.edited === 1,
        seenAt: row.seenAt,
        pending: row.pushRevision !== null,
      }));

  const libraryItems = Effect.gen(function* () {
    const roles = yield* crew.listRoles();
    const workflows = yield* crew.listWorkflows();
    return [
      ...roles.map((item): Item => ({ kind: "role", item })),
      ...workflows.map((item): Item => ({ kind: "workflow", item })),
    ];
  });

  const heldFrom = (items: ReadonlyArray<Item>, source: EnvironmentId) =>
    items.filter((entry) => entry.item.importedFrom?.environmentId === source);

  const holdsOf = (held: ReadonlyArray<Item>) =>
    held.map((entry) => ({
      kind: entry.kind,
      id: entry.item.id,
      revision: entry.item.importedFrom?.revision ?? null,
      edited: editedHere(entry.item),
    }));

  /** Opening the library asks the sources again, unless a sync just ran. */
  const wakeIfStale = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now - (yield* Ref.get(lastSyncAt)) > SYNC_ON_OPEN_AFTER_MS) {
      yield* Queue.offer(wake, undefined);
    }
  });

  const listRoles: LibraryImports["Service"]["listRoles"] = Effect.gen(function* () {
    yield* wakeIfStale;
    const rows = yield* importerRows;
    return (yield* crew.listRoles()).map((role) => ({
      ...role,
      importers: importersOf(rows, "role", role.id),
    }));
  }).pipe(Effect.withSpan("LibraryImports.listRoles"));

  const listWorkflows: LibraryImports["Service"]["listWorkflows"] = Effect.gen(function* () {
    yield* wakeIfStale;
    const rows = yield* importerRows;
    return (yield* crew.listWorkflows()).map((workflow) => ({
      ...workflow,
      importers: importersOf(rows, "workflow", workflow.id),
    }));
  }).pipe(Effect.withSpan("LibraryImports.listWorkflows"));

  const withImporters = Effect.fn("LibraryImports.withImporters")(function* <
    T extends Role | Workflow,
  >(kind: LibraryItemKind, item: T) {
    return { ...item, importers: importersOf(yield* importerRows, kind, item.id) };
  });

  /**
   * Importers ticked on save take exactly `revision` on their next sync, replacing local edits
   * only where the person agreed to. A save that doesn't tick one withdraws what waited for it.
   */
  const sendTo = Effect.fn("LibraryImports.sendTo")(function* (
    kind: LibraryItemKind,
    id: string,
    revision: number,
    targets: ReadonlyArray<LibraryPushTarget> | undefined,
  ) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Saves commit their content first, so two can get here out of order: the later
          // save's targets stand.
          const [current] = yield* kind === "role"
            ? sql<{ readonly revision: number }>`SELECT revision FROM roles WHERE id = ${id}`
            : sql<{ readonly revision: number }>`SELECT revision FROM workflows WHERE id = ${id}`;
          if (current !== undefined && current.revision > revision) return;
          yield* sql`
            UPDATE library_importers SET push_revision = NULL, push_overwrites = 0
            WHERE kind = ${kind} AND item_id = ${id}
          `;
          for (const target of targets ?? []) {
            yield* sql`
              UPDATE library_importers SET push_revision = ${revision},
                push_overwrites = ${target.replacesEdits ? 1 : 0}
              WHERE environment_id = ${target.environmentId} AND kind = ${kind}
                AND item_id = ${id}
            `;
          }
        }),
      )
      .pipe(Effect.mapError(queryError));
  });

  /** How this server reaches a source: as itself, not any agent's thread. */
  const callScope = (environmentId: EnvironmentId): McpInvocationContext.McpInvocationScope => ({
    environmentId,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
    requestNamespace: "library-imports",
    thread: undefined,
    client: undefined,
  });

  const callSource = Effect.fn("LibraryImports.callSource")(function* (
    source: EnvironmentId,
    input: LibrarySyncInput,
  ) {
    const link = yield* links.get(source).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(link)) return yield* new SourceProblem({ problem: "notLinked" });
    if (DateTime.isLessThanOrEqualTo(link.value.expiresAt, yield* DateTime.now)) {
      return yield* new SourceProblem({ problem: "expired" });
    }
    const result = yield* forwarding
      .call(callScope(input.importer.environmentId), LinkLibrarySync, source, input)
      .pipe(
        Effect.timeoutOrElse({
          duration: CALL_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new OrchestratorMcpFailure({ code: "orchestration_error", message: "No answer." }),
            ),
        }),
        Effect.mapError((error) => new SourceProblem({ problem: problemOf(error) })),
      );
    return { label: link.value.label, result };
  });

  const labelOf = (source: EnvironmentId) =>
    links.get(source).pipe(
      Effect.map(Option.match({ onNone: () => source as string, onSome: (link) => link.label })),
      Effect.orElseSucceed(() => source as string),
    );

  const statusOf = (
    existing: Role | Workflow | null,
    source: EnvironmentId,
    revision: number,
  ): LibraryImportableItem["status"] => {
    if (existing === null) return "new";
    if (existing.importedFrom?.environmentId !== source) return "replaces";
    return existing.importedFrom.revision === revision && !editedHere(existing)
      ? "current"
      : "update";
  };

  /** The one path for importing, taking an update and taking a pushed save. */
  const importFrom = Effect.fn("LibraryImports.importFrom")(function* (
    source: EnvironmentId,
    wanted: Omit<typeof LibraryImportInput.Type, "sourceEnvironmentId">,
    /**
     * For pushed saves: the source revision the person sent, and this one's revision here when
     * it was checked as unedited (null when they agreed to replace edits). Anything else is left
     * alone and shows as an update instead.
     */
    pushes?: ReadonlyMap<string, { readonly revision: number; readonly local: number | null }>,
  ) {
    const me = yield* self;
    const items = yield* libraryItems;
    const answered = yield* callSource(source, {
      importer: me,
      holds: holdsOf(heldFrom(items, source)),
      list: true,
    }).pipe(
      Effect.catchTags({
        SourceProblem: (error) =>
          labelOf(source).pipe(
            Effect.flatMap((label) =>
              Effect.fail(new CrewValidationError(problemText(error.problem, label))),
            ),
          ),
      }),
    );
    const { label, result } = answered;
    const listed = new Map(
      result.items.flatMap((item) =>
        item.content === undefined ? [] : [[keyOf(item.kind, item.id), item] as const],
      ),
    );
    const local = new Map(items.map((entry) => [keyOf(entry.kind, entry.item.id), entry.item]));
    // A workflow brings the roles it names that this machine lacks.
    const roleIds = new Set(wanted.roleIds);
    for (const id of wanted.workflowIds) {
      for (const roleId of listed.get(keyOf("workflow", id))?.content?.crewRoleIds ?? []) {
        if (!local.has(keyOf("role", roleId))) roleIds.add(roleId);
      }
    }
    const plan = [
      ...[...roleIds].map((id) => ({ kind: "role" as const, id })),
      ...wanted.workflowIds.map((id) => ({ kind: "workflow" as const, id })),
    ];
    const imported: Array<LibraryImportResult["imported"][number]> = [];
    const skipped: Array<LibraryImportResult["skipped"][number]> = [];
    const now = DateTime.formatIso(yield* DateTime.now);
    const conflict = (name: string) =>
      new CrewValidationError(`${name} changed while it was being imported. Try again.`);
    yield* store.transaction(
      Effect.gen(function* () {
        for (const { kind, id } of plan) {
          const there = listed.get(keyOf(kind, id));
          const content = there?.content;
          if (there === undefined || content === undefined) {
            skipped.push({ kind, id, reason: "missing" });
            continue;
          }
          // Read again: an edit here may have landed while the source answered.
          const existing =
            kind === "role" ? yield* store.getRole(id) : yield* store.getWorkflow(id);
          const pushed = pushes?.get(keyOf(kind, id));
          const checked = pushed === undefined ? undefined : pushed.local;
          if (pushed !== undefined && there.revision !== pushed.revision) {
            skipped.push({ kind, id, reason: "current" });
            continue;
          }
          if (checked != null && existing?.revision !== checked) {
            skipped.push({ kind, id, reason: "edited" });
            continue;
          }
          const status = statusOf(existing, source, there.revision);
          if (status === "current" || (status === "replaces" && !wanted.replace)) {
            skipped.push({ kind, id, reason: status === "current" ? "current" : "replaces" });
            continue;
          }
          const importedFrom = (localRevision: number): ImportedFrom => ({
            environmentId: source,
            label,
            revision: there.revision,
            localRevision,
            available: null,
            skipped: null,
            problem: null,
          });
          const revision = (existing?.revision ?? 0) + 1;
          if (kind === "role") {
            if (content.modelSelection === undefined) {
              skipped.push({ kind, id, reason: "missing" });
              continue;
            }
            const previous = existing as Role | null;
            const role: Role = {
              id,
              name: content.name,
              instructions: content.instructions,
              modelSelection: content.modelSelection,
              fallbackModelSelection: content.fallbackModelSelection ?? null,
              // An update leaves whether it is on here as it is.
              enabled: previous?.enabled ?? content.enabled ?? true,
              importedFrom: importedFrom(revision),
              revision,
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
            };
            if (previous === null) yield* store.insertRole(role);
            else if (!(yield* store.updateRole(role, previous.revision))) {
              if (pushed === undefined) return yield* Effect.fail(conflict(previous.name));
              skipped.push({ kind, id, reason: "edited" });
              continue;
            }
          } else {
            const crewRoleIds: Array<string> = [];
            for (const roleId of content.crewRoleIds ?? []) {
              if (yield* store.getRole(roleId)) crewRoleIds.push(roleId);
            }
            const previous = existing as Workflow | null;
            const workflow: Workflow = {
              id,
              name: content.name,
              instructions: content.instructions,
              crewRoleIds,
              importedFrom: importedFrom(revision),
              revision,
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
            };
            if (previous === null) yield* store.insertWorkflow(workflow);
            else if (!(yield* store.updateWorkflow(workflow, previous.revision))) {
              if (pushed === undefined) return yield* Effect.fail(conflict(previous.name));
              skipped.push({ kind, id, reason: "edited" });
              continue;
            }
          }
          imported.push({ kind, id, name: content.name });
        }
      }),
    );
    if (imported.length > 0) {
      yield* notify("library");
      // The source learns what this machine now holds on the next sync.
      yield* Queue.offer(wake, undefined);
    }
    return { imported, skipped } satisfies LibraryImportResult;
  });

  const importable: LibraryImports["Service"]["importable"] = Effect.fn(
    "LibraryImports.importable",
  )(function* (source) {
    const me = yield* self;
    const items = yield* libraryItems;
    const answered = yield* callSource(source, {
      importer: me,
      holds: holdsOf(heldFrom(items, source)),
      list: true,
    }).pipe(Effect.result);
    if (Result.isFailure(answered)) {
      return {
        source: { environmentId: source, label: yield* labelOf(source) },
        problem: answered.failure.problem,
        items: [],
      };
    }
    const local = new Map(items.map((entry) => [keyOf(entry.kind, entry.item.id), entry]));
    const listed = answered.success.result.items.flatMap((item): Array<LibraryImportableItem> => {
      if (item.content === undefined) return [];
      const existing = local.get(keyOf(item.kind, item.id)) ?? null;
      const status = statusOf(existing?.item ?? null, source, item.revision);
      return [
        {
          kind: item.kind,
          id: item.id,
          name: item.content.name,
          revision: item.revision,
          crewRoleIds: item.content.crewRoleIds ?? [],
          status,
          replaces:
            status === "replaces" && existing !== null
              ? {
                  name: existing.item.name,
                  importedFrom: existing.item.importedFrom?.label ?? null,
                  stock:
                    existing.item.importedFrom === null && isStock(existing.kind, existing.item),
                }
              : null,
        },
      ];
    });
    return {
      source: { environmentId: source, label: answered.success.label },
      problem: null,
      items: listed.sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      ),
    };
  });

  const syncSource = Effect.fn("LibraryImports.syncSource")(function* (
    source: EnvironmentId,
    evenIfEmpty: boolean,
  ) {
    const me = yield* self;
    const held = heldFrom(yield* libraryItems, source);
    if (held.length === 0 && !evenIfEmpty) return;
    const answered = yield* callSource(source, { importer: me, holds: holdsOf(held) }).pipe(
      Effect.result,
    );
    let changed = false;
    const write = Effect.fn(function* (entry: Item, next: ImportedFrom) {
      if (sameImportedFrom(next, entry.item.importedFrom)) return;
      yield* store.setImportedFrom(entry.kind, entry.item.id, next);
      changed = true;
    });
    if (Result.isFailure(answered)) {
      for (const entry of held) {
        if (entry.item.importedFrom === null) continue;
        yield* write(entry, { ...entry.item.importedFrom, problem: answered.failure.problem });
      }
    } else {
      const { label, result } = answered.success;
      const there = new Map(result.items.map((item) => [keyOf(item.kind, item.id), item]));
      const gone = new Set(result.missing.map((item) => keyOf(item.kind, item.id)));
      for (const entry of held) {
        const from = entry.item.importedFrom;
        if (from === null) continue;
        const item = there.get(keyOf(entry.kind, entry.item.id));
        if (item === undefined || gone.has(keyOf(entry.kind, entry.item.id))) {
          yield* write(entry, { ...from, label, problem: "removed" });
          continue;
        }
        // A copy from before imports holds an unknown revision: the same content is current.
        const next: ImportedFrom =
          from.revision === null && item.content !== undefined && sameContent(entry, item.content)
            ? { ...from, label, problem: null, revision: item.revision, available: null }
            : {
                ...from,
                label,
                problem: null,
                available: item.revision > (from.revision ?? -1) ? item.revision : null,
              };
        yield* write(entry, next);
      }
      // A save sent here is taken unless this copy changed since that person was warned.
      const takes = result.push.filter((sent) => {
        const entry = held.find(
          (candidate) => candidate.kind === sent.kind && candidate.item.id === sent.id,
        );
        return entry !== undefined && (sent.overwrites || !editedHere(entry.item));
      });
      if (takes.length > 0) {
        const checkedAt = new Map(
          held.map((entry) => [keyOf(entry.kind, entry.item.id), entry.item.revision]),
        );
        yield* importFrom(
          source,
          {
            roleIds: takes.filter((sent) => sent.kind === "role").map((sent) => sent.id),
            workflowIds: takes.filter((sent) => sent.kind === "workflow").map((sent) => sent.id),
            replace: false,
          },
          new Map(
            takes.map((sent) => [
              keyOf(sent.kind, sent.id),
              {
                revision: sent.revision,
                local: sent.overwrites ? null : (checkedAt.get(keyOf(sent.kind, sent.id)) ?? null),
              },
            ]),
          ),
        );
      }
    }
    if (changed) yield* notify("library");
  });

  const syncAll: Effect.Effect<void> = writing
    .withPermits(1)(
      Effect.gen(function* () {
        if (!(yield* links.enabled)) return;
        yield* Ref.set(lastSyncAt, yield* Clock.currentTimeMillis);
        const sources = new Set(
          (yield* libraryItems).flatMap((entry) =>
            entry.item.importedFrom === null ? [] : [entry.item.importedFrom.environmentId],
          ),
        );
        const told = yield* Ref.getAndSet(forgotten, new Set());
        yield* Effect.forEach(
          new Set([...sources, ...told]),
          (source) =>
            syncSource(source, told.has(source)).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Syncing imported workflows and roles failed", {
                  source,
                  cause,
                }),
              ),
            ),
          { concurrency: 4, discard: true },
        );
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Syncing imported workflows and roles failed", { cause }),
      ),
      Effect.withSpan("LibraryImports.syncAll"),
    );

  /** An importer's sync: what it holds replaces what it held, and it hears what changed here. */
  const answerSync = Effect.fn("LibraryImports.answerSync")(function* (input: LibrarySyncInput) {
    const unavailable = (error: { readonly message: string }) =>
      new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
    const importer = input.importer;
    const now = DateTime.formatIso(yield* DateTime.now);
    const here = yield* self;
    const answer = new Map<string, LibrarySyncResult["items"][number]>();
    const push: Array<LibrarySyncResult["push"][number]> = [];
    const missing: Array<LibrarySyncResult["missing"][number]> = [];
    let items: ReadonlyArray<Item> = [];
    let changed = false;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Read in the transaction that writes, so a save and the push it sent, committed
          // meanwhile, are seen here rather than written over.
          items = yield* libraryItems;
          const byKey = new Map(items.map((entry) => [keyOf(entry.kind, entry.item.id), entry]));
          const previous = new Map(
            (yield* importerRows)
              .filter((row) => row.environmentId === importer.environmentId)
              .map((row) => [keyOf(row.kind, row.itemId), row]),
          );
          yield* sql`DELETE FROM library_importers WHERE environment_id = ${importer.environmentId}`;
          for (const held of input.holds) {
            const key = keyOf(held.kind, held.id);
            const entry = byKey.get(key);
            if (entry === undefined) {
              missing.push({ kind: held.kind, id: held.id });
              continue;
            }
            const last = previous.get(key);
            previous.delete(key);
            const overwrites = last?.pushOverwrites === 1;
            // Taken; refused because it was edited there and nobody agreed to replace that;
            // or overtaken by a change here the person didn't send.
            const pushRevision =
              last?.pushRevision == null ||
              (held.revision ?? -1) >= last.pushRevision ||
              (held.edited && !overwrites) ||
              last.pushRevision !== entry.item.revision
                ? null
                : last.pushRevision;
            yield* sql`
              INSERT INTO library_importers (
                environment_id, label, kind, item_id, revision, edited, push_revision,
                push_overwrites, seen_at
              ) VALUES (
                ${importer.environmentId}, ${importer.label}, ${held.kind}, ${held.id},
                ${held.revision}, ${held.edited ? 1 : 0}, ${pushRevision}, ${overwrites ? 1 : 0},
                ${now}
              )
            `;
            if (
              last === undefined ||
              last.label !== importer.label ||
              last.revision !== held.revision ||
              (last.edited === 1) !== held.edited ||
              last.pushRevision !== pushRevision
            ) {
              changed = true;
            }
            answer.set(key, {
              kind: held.kind,
              id: held.id,
              revision: entry.item.revision,
              ...(held.revision === null ? { content: contentOf(entry) } : {}),
            });
            if (pushRevision !== null) {
              push.push({
                kind: held.kind,
                id: held.id,
                revision: entry.item.revision,
                overwrites,
              });
            }
          }
          if (previous.size > 0) changed = true;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          unavailable("_tag" in error && error._tag === "SqlError" ? queryError(error) : error),
        ),
      );
    if (input.list === true) {
      for (const entry of items) {
        // What the caller gave this machine never goes back to it.
        if (entry.item.importedFrom?.environmentId === importer.environmentId) continue;
        answer.set(keyOf(entry.kind, entry.item.id), {
          kind: entry.kind,
          id: entry.item.id,
          revision: entry.item.revision,
          content: contentOf(entry),
          importedFrom: entry.item.importedFrom?.label ?? null,
        });
      }
    }
    if (changed) yield* notify("library");
    return { label: here.label, items: [...answer.values()], push, missing };
  });

  const serveSync: LibraryImports["Service"]["serveSync"] = Effect.fn("LibraryImports.serveSync")(
    function* (scope, input) {
      const refuse = (message: string) =>
        Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message }));
      if (scope.client?.linked !== true) {
        return yield* refuse("Only a linked environment imports workflows and roles from here.");
      }
      if (scope.client.access !== "full-access") {
        const { label } = yield* self;
        return yield* refuse(
          `${label} is linked with ${scope.client.access} access, and importing its workflows and roles needs full access. Link ${label} again with full access in Settings → Environments → Linked environments.`,
        );
      }
      return yield* answerSync(input);
    },
  );

  const detach: LibraryImports["Service"]["detach"] = Effect.fn("LibraryImports.detach")(
    function* (input) {
      yield* writing.withPermits(1)(
        Effect.gen(function* () {
          const item =
            input.kind === "role"
              ? yield* store.getRole(input.id)
              : yield* store.getWorkflow(input.id);
          const from = item?.importedFrom ?? null;
          if (from === null) return;
          if (input.mode === "skip") {
            yield* store.setImportedFrom(input.kind, input.id, {
              ...from,
              skipped: from.available,
            });
          } else {
            yield* store.setImportedFrom(input.kind, input.id, null);
            // Its source drops this machine from its importers on the next sync.
            yield* Ref.update(forgotten, (sources) => new Set([...sources, from.environmentId]));
            yield* Queue.offer(wake, undefined);
          }
          yield* notify("library");
        }),
      );
    },
  );

  const unlink: LibraryImports["Service"]["unlink"] = Effect.fn("LibraryImports.unlink")(
    function* (environmentId) {
      return yield* writing.withPermits(1)(
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            yield* callSource(environmentId, { importer: yield* self, holds: [] });
          }).pipe(Effect.ignore);
          const result = yield* links.unlink(environmentId);
          yield* Effect.gen(function* () {
            for (const entry of heldFrom(yield* libraryItems, environmentId)) {
              if (entry.item.importedFrom === null) continue;
              yield* store.setImportedFrom(entry.kind, entry.item.id, {
                ...entry.item.importedFrom,
                problem: "notLinked",
              });
            }
            yield* notify("library");
          }).pipe(Effect.ignoreCause({ log: true }));
          return result;
        }),
      );
    },
  );

  const run: LibraryImports["Service"]["run"] = Effect.forever(
    syncAll.pipe(
      Effect.andThen(
        Queue.take(wake).pipe(
          Effect.timeoutOrElse({ duration: SYNC_INTERVAL, orElse: () => Effect.void }),
        ),
      ),
    ),
  );

  return LibraryImports.of({
    listRoles,
    listWorkflows,
    createRole: Effect.fn("LibraryImports.createRole")(function* (input) {
      return yield* withImporters("role", yield* crew.createRole(input));
    }),
    updateRole: Effect.fn("LibraryImports.updateRole")(function* (input) {
      const role = yield* crew.updateRole(input);
      yield* sendTo("role", role.id, role.revision, input.alsoUpdateOn);
      return yield* withImporters("role", role);
    }),
    createWorkflow: Effect.fn("LibraryImports.createWorkflow")(function* (input) {
      return yield* withImporters("workflow", yield* crew.createWorkflow(input));
    }),
    updateWorkflow: Effect.fn("LibraryImports.updateWorkflow")(function* (input) {
      const workflow = yield* crew.updateWorkflow(input);
      yield* sendTo("workflow", workflow.id, workflow.revision, input.alsoUpdateOn);
      return yield* withImporters("workflow", workflow);
    }),
    deleteWorkflow: Effect.fn("LibraryImports.deleteWorkflow")(function* (id) {
      yield* crew.deleteWorkflow(id);
    }),
    importable,
    importItems: Effect.fn("LibraryImports.importItems")(function* (input) {
      return yield* writing.withPermits(1)(
        importFrom(input.sourceEnvironmentId, {
          roleIds: input.roleIds,
          workflowIds: input.workflowIds,
          replace: input.replace,
        }),
      );
    }),
    detach,
    serveSync,
    unlink,
    syncNow: syncAll,
    run,
  });
});

export const layer = Layer.effect(LibraryImports, make);

/**
 * Unlinks `environmentId` from the CLI, which runs without `LibraryImports`: it tells that
 * machine first, as `unlink` does. The server's next sync marks what came from it not linked.
 */
export const unlinkFromCli = Effect.fn("LibraryImports.unlinkFromCli")(function* (
  environmentId: EnvironmentId,
) {
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  yield* Effect.gen(function* () {
    if (!(yield* links.enabled)) return;
    const { environmentId: here, label } = yield* environment.getDescriptor;
    const forget: LibrarySyncInput = {
      importer: { environmentId: here, label },
      holds: [],
    };
    yield* peers
      .call({
        environmentId,
        tool: LinkLibrarySync.name,
        arguments: forget,
        limits: McpInvocationContext.clientModeCeiling(undefined),
        success: LinkLibrarySync.successSchema,
      })
      .pipe(Effect.timeout(CALL_TIMEOUT));
  }).pipe(Effect.ignore);
  return yield* links.unlink(environmentId);
});

/**
 * Unlinks `environmentId`, through `LibraryImports` where this server runs it so that machine
 * forgets this one as an importer first. Upstream's link tools and their tests run without it.
 */
export const unlinkEnvironment = (environmentId: EnvironmentId) =>
  Effect.serviceOption(LibraryImports).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          PeerLinks.PeerLinks.pipe(Effect.flatMap((links) => links.unlink(environmentId))),
        onSome: (imports) => imports.unlink(environmentId),
      }),
    ),
  );
