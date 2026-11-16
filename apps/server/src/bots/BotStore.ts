import { Bot, EnvironmentId, ModelSelection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

/** One row of `bots`, with its JSON columns still encoded. */
const BotRow = Schema.Struct({
  ...Bot.fields,
  avatar: Schema.fromJsonString(Bot.fields.avatar),
  withheldTools: Schema.fromJsonString(Bot.fields.withheldTools),
  permittedEnvironmentIds: Schema.fromJsonString(Bot.fields.permittedEnvironmentIds),
  modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  pinned: Schema.BooleanFromBit,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(BotRow));
const encodeRow = Schema.encodeSync(BotRow);

/** Where a bot is moving and the ID its copy there has, until the move finishes. */
export const PendingMove = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  newBotId: Schema.String,
});
export type PendingMove = typeof PendingMove.Type;
/** The bot on another environment a copy here was made from. */
export const CopiedFrom = Schema.Struct({ environmentId: EnvironmentId, botId: Schema.String });
export type CopiedFrom = typeof CopiedFrom.Type;
const PendingMoveJson = Schema.NullOr(Schema.fromJsonString(PendingMove));
const CopiedFromJson = Schema.NullOr(Schema.fromJsonString(CopiedFrom));
const encodePendingMove = Schema.encodeSync(PendingMoveJson);
const decodePendingMove = Schema.decodeEffect(PendingMoveJson);
const encodeCopiedFrom = Schema.encodeSync(CopiedFromJson);
const decodeCopiedFrom = Schema.decodeEffect(CopiedFromJson);

export type DeleteBotResult = "deleted" | "missing" | "owns-projects";

export class BotStore extends Context.Service<
  BotStore,
  {
    /** Every bot in rail order. Deleted bots are left out here and in `get`. */
    readonly list: Effect.Effect<ReadonlyArray<Bot>, PersistenceSqlError>;
    readonly get: (id: string) => Effect.Effect<Bot | null, PersistenceSqlError>;
    /**
     * False when the ID is taken, by a bot (deleted ones too) or by a crew member. `copiedFrom`
     * names the bot on another environment a copy was made from.
     */
    readonly insert: (
      bot: Bot,
      copiedFrom?: CopiedFrom,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
    /** The move a bot has under way, or null; null too for a missing bot. */
    readonly pendingMove: (id: string) => Effect.Effect<PendingMove | null, PersistenceSqlError>;
    readonly setPendingMove: (
      id: string,
      move: PendingMove | null,
    ) => Effect.Effect<void, PersistenceSqlError>;
    /** The bot another environment's copy here came from, or null for any other bot. */
    readonly copiedFrom: (id: string) => Effect.Effect<CopiedFrom | null, PersistenceSqlError>;
    /** False when the bot changed since `expectedRevision`. */
    readonly update: (
      bot: Bot,
      expectedRevision: number,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
    /**
     * Marks the bot deleted unless an active project other than its home still belongs to it.
     * Call it inside `withOwnership`, like every change that gives a project to a bot.
     */
    readonly deleteUnlessOwning: (
      id: string,
      deletedAt: string,
      homeWorkspaceRoot: string | null,
    ) => Effect.Effect<DeleteBotResult, PersistenceSqlError>;
    /** Frees a deleted bot's ID, as for a copy that was undone before anyone used it. */
    readonly purge: (id: string) => Effect.Effect<void, PersistenceSqlError>;
    /** Pins the bot to the main rail or unpins it; false when there's no such bot. */
    readonly setPinned: (
      id: string,
      pinned: boolean,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
    /** Writes rail positions in the given order. */
    readonly setPositions: (
      botIds: ReadonlyArray<string>,
      updatedAt: string,
    ) => Effect.Effect<void, PersistenceSqlError>;
    /**
     * Runs `effect` while no other ownership change runs: checking a bot exists and committing
     * a project to it can't interleave with deleting that bot.
     */
    readonly withOwnership: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** Whether any bot, deleted or not, has this ID. Bots and crew members share IDs' space. */
    readonly idTaken: (id: string) => Effect.Effect<boolean, PersistenceSqlError>;
    /** The bot that owns an active project, or null for a missing project or one with no bot. */
    readonly projectOwner: (projectId: string) => Effect.Effect<string | null, PersistenceSqlError>;
    /**
     * Ticks a newly linked environment for every bot that hasn't got it, bumping each one's
     * revision; returns how many changed. Called once per new link; a re-link leaves a person's
     * unticking alone.
     */
    readonly permitEnvironmentForAll: (
      environmentId: EnvironmentId,
      updatedAt: string,
    ) => Effect.Effect<number, PersistenceSqlError>;
    /** Every environment linked now, which a new bot may work on until a person unticks it. */
    readonly linkedEnvironmentIds: Effect.Effect<ReadonlyArray<EnvironmentId>, PersistenceSqlError>;
  }
>()("t3/bots/BotStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const queryError = toPersistenceSqlError("BotStore.query");
  const decodeError = toPersistenceSqlError("BotStore.decode");
  // One server process owns the database, so a process-wide permit serializes ownership.
  const ownership = yield* Semaphore.make(1);

  const select = (id?: string) =>
    sql`
      SELECT id, name, avatar_json AS "avatar", color, instructions, withheld_tools_json AS "withheldTools",
        runtime_mode AS "runtimeMode", model_selection_json AS "modelSelection",
        long_conversation AS "longConversation",
        permitted_environment_ids_json AS "permittedEnvironmentIds",
        position, pinned, revision,
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM bots WHERE deleted_at IS NULL AND ${id === undefined ? sql`1 = 1` : sql`id = ${id}`}
      ORDER BY position, created_at, id
    `.pipe(
      Effect.mapError(queryError),
      Effect.flatMap((rows) => decodeRows(rows).pipe(Effect.mapError(decodeError))),
    );

  return BotStore.of({
    list: select(),
    get: Effect.fn("BotStore.get")((id) => select(id).pipe(Effect.map((rows) => rows[0] ?? null))),
    insert: Effect.fn("BotStore.insert")((bot, copiedFrom) => {
      const row = encodeRow({ ...bot, pinned: bot.pinned ?? true });
      const origin = encodeCopiedFrom(copiedFrom ?? null);
      return sql<{ readonly id: string }>`
        INSERT OR IGNORE INTO bots (
          id, name, avatar_json, color, instructions, withheld_tools_json, runtime_mode,
          model_selection_json, long_conversation, permitted_environment_ids_json, position,
          pinned, revision, created_at, updated_at, copied_from_json
        )
        SELECT ${row.id}, ${row.name}, ${row.avatar}, ${row.color}, ${row.instructions},
          ${row.withheldTools}, ${row.runtimeMode}, ${row.modelSelection},
          ${row.longConversation}, ${row.permittedEnvironmentIds}, ${row.position}, ${row.pinned}, ${row.revision},
          ${row.createdAt}, ${row.updatedAt}, ${origin}
        WHERE NOT EXISTS (SELECT 1 FROM crew_members WHERE id = ${row.id})
        RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(queryError),
      );
    }),
    update: Effect.fn("BotStore.update")((bot, expectedRevision) => {
      const row = encodeRow({ ...bot, pinned: bot.pinned ?? true });
      return sql<{ readonly id: string }>`
        UPDATE bots SET
          name = ${row.name}, avatar_json = ${row.avatar}, color = ${row.color},
          instructions = ${row.instructions}, withheld_tools_json = ${row.withheldTools},
          runtime_mode = ${row.runtimeMode}, model_selection_json = ${row.modelSelection},
          long_conversation = ${row.longConversation},
          permitted_environment_ids_json = ${row.permittedEnvironmentIds}, revision = ${row.revision},
          updated_at = ${row.updatedAt}
        WHERE id = ${row.id} AND revision = ${expectedRevision}
        RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(queryError),
      );
    }),
    deleteUnlessOwning: Effect.fn("BotStore.deleteUnlessOwning")(
      (id, deletedAt, homeWorkspaceRoot) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const deleted = yield* sql<{ readonly id: string }>`
              UPDATE bots SET deleted_at = ${deletedAt}
              WHERE id = ${id} AND deleted_at IS NULL AND NOT EXISTS (
                SELECT 1 FROM projection_projects WHERE bot_id = ${id} AND deleted_at IS NULL
                  AND workspace_root IS NOT ${homeWorkspaceRoot}
              )
              RETURNING id
            `;
              if (deleted.length > 0) return "deleted" as const;
              const existing =
                yield* sql`SELECT 1 FROM bots WHERE id = ${id} AND deleted_at IS NULL`;
              return existing.length > 0 ? ("owns-projects" as const) : ("missing" as const);
            }),
          )
          .pipe(Effect.mapError(queryError)),
    ),
    pendingMove: Effect.fn("BotStore.pendingMove")((id) =>
      sql<{ readonly json: string | null }>`
        SELECT moving_json AS json FROM bots WHERE id = ${id} AND deleted_at IS NULL
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          decodePendingMove(rows[0]?.json ?? null).pipe(Effect.mapError(decodeError)),
        ),
      ),
    ),
    setPendingMove: Effect.fn("BotStore.setPendingMove")((id, move) =>
      sql`
        UPDATE bots SET moving_json = ${encodePendingMove(move)} WHERE id = ${id}
      `.pipe(Effect.asVoid, Effect.mapError(queryError)),
    ),
    copiedFrom: Effect.fn("BotStore.copiedFrom")((id) =>
      sql<{ readonly json: string | null }>`
        SELECT copied_from_json AS json FROM bots WHERE id = ${id} AND deleted_at IS NULL
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          decodeCopiedFrom(rows[0]?.json ?? null).pipe(Effect.mapError(decodeError)),
        ),
      ),
    ),
    purge: Effect.fn("BotStore.purge")((id) =>
      sql`DELETE FROM bots WHERE id = ${id} AND deleted_at IS NOT NULL`.pipe(
        Effect.asVoid,
        Effect.mapError(queryError),
      ),
    ),
    setPinned: Effect.fn("BotStore.setPinned")((id, pinned) =>
      sql<{ readonly id: string }>`
        UPDATE bots SET pinned = ${pinned ? 1 : 0} WHERE id = ${id} AND deleted_at IS NULL
        RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(queryError),
      ),
    ),
    setPositions: Effect.fn("BotStore.setPositions")((botIds, updatedAt) =>
      sql
        .withTransaction(
          Effect.forEach(
            botIds,
            (id, position) =>
              sql`UPDATE bots SET position = ${position}, updated_at = ${updatedAt} WHERE id = ${id}`,
            { discard: true },
          ),
        )
        .pipe(Effect.mapError(queryError)),
    ),
    withOwnership: ownership.withPermits(1),
    idTaken: Effect.fn("BotStore.idTaken")((id) =>
      sql`SELECT 1 FROM bots WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(queryError),
      ),
    ),
    projectOwner: Effect.fn("BotStore.projectOwner")((projectId) =>
      sql<{ readonly botId: string | null }>`
        SELECT bot_id AS "botId" FROM projection_projects
        WHERE project_id = ${projectId} AND deleted_at IS NULL
      `.pipe(
        Effect.map((rows) => rows[0]?.botId ?? null),
        Effect.mapError(queryError),
      ),
    ),
    permitEnvironmentForAll: Effect.fn("BotStore.permitEnvironmentForAll")(
      (environmentId, updatedAt) =>
        sql`
        UPDATE bots SET
          permitted_environment_ids_json =
            json_insert(permitted_environment_ids_json, '$[#]', ${environmentId}),
          revision = revision + 1, updated_at = ${updatedAt}
        WHERE deleted_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM json_each(bots.permitted_environment_ids_json) WHERE value = ${environmentId}
        )
        RETURNING id
      `.pipe(
          Effect.map((rows) => rows.length),
          Effect.mapError(queryError),
        ),
    ),
    linkedEnvironmentIds: sql<{ readonly id: string }>`
      SELECT environment_id AS id FROM peer_environment_links ORDER BY environment_id
    `.pipe(
      Effect.map((rows) => rows.map((row) => EnvironmentId.make(row.id))),
      Effect.mapError(queryError),
    ),
  });
});

export const layer = Layer.effect(BotStore, make);
