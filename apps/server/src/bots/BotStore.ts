import { Bot, ModelSelection } from "@t3tools/contracts";
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
  allowedTools: Schema.fromJsonString(Bot.fields.allowedTools),
  modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(BotRow));
const encodeRow = Schema.encodeSync(BotRow);

export type DeleteBotResult = "deleted" | "missing" | "owns-projects";

export class BotStore extends Context.Service<
  BotStore,
  {
    /** Every bot in rail order. Deleted bots are left out here and in `get`. */
    readonly list: Effect.Effect<ReadonlyArray<Bot>, PersistenceSqlError>;
    readonly get: (id: string) => Effect.Effect<Bot | null, PersistenceSqlError>;
    /** False when the ID is taken, by a bot (deleted ones too) or by a crew member. */
    readonly insert: (bot: Bot) => Effect.Effect<boolean, PersistenceSqlError>;
    /** False when the bot changed since `expectedRevision`. */
    readonly update: (
      bot: Bot,
      expectedRevision: number,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
    /**
     * Marks the bot deleted unless an active project still belongs to it. Call it inside
     * `withOwnership`, like every change that gives a project to a bot.
     */
    readonly deleteUnlessOwning: (
      id: string,
      deletedAt: string,
    ) => Effect.Effect<DeleteBotResult, PersistenceSqlError>;
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
    /** The bot that owns an active project, or null for a missing project. */
    readonly projectOwner: (projectId: string) => Effect.Effect<string | null, PersistenceSqlError>;
    /** The oldest active project the bot owns, or null when it owns none. */
    readonly firstOwnedProject: (
      botId: string,
    ) => Effect.Effect<string | null, PersistenceSqlError>;
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
      SELECT id, name, avatar_json AS "avatar", color, instructions, allowed_tools_json AS "allowedTools",
        runtime_mode AS "runtimeMode", model_selection_json AS "modelSelection",
        default_workflow_id AS "defaultWorkflowId", long_conversation AS "longConversation",
        position, revision,
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
    insert: Effect.fn("BotStore.insert")((bot) => {
      const row = encodeRow(bot);
      return sql<{ readonly id: string }>`
        INSERT OR IGNORE INTO bots (
          id, name, avatar_json, color, instructions, allowed_tools_json, runtime_mode,
          model_selection_json, default_workflow_id, long_conversation, position, revision,
          created_at, updated_at
        )
        SELECT ${row.id}, ${row.name}, ${row.avatar}, ${row.color}, ${row.instructions},
          ${row.allowedTools}, ${row.runtimeMode}, ${row.modelSelection},
          ${row.defaultWorkflowId}, ${row.longConversation}, ${row.position}, ${row.revision},
          ${row.createdAt}, ${row.updatedAt}
        WHERE NOT EXISTS (SELECT 1 FROM crew_members WHERE id = ${row.id})
        RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(queryError),
      );
    }),
    update: Effect.fn("BotStore.update")((bot, expectedRevision) => {
      const row = encodeRow(bot);
      return sql<{ readonly id: string }>`
        UPDATE bots SET
          name = ${row.name}, avatar_json = ${row.avatar}, color = ${row.color},
          instructions = ${row.instructions}, allowed_tools_json = ${row.allowedTools},
          runtime_mode = ${row.runtimeMode}, model_selection_json = ${row.modelSelection},
          default_workflow_id = ${row.defaultWorkflowId},
          long_conversation = ${row.longConversation}, revision = ${row.revision},
          updated_at = ${row.updatedAt}
        WHERE id = ${row.id} AND revision = ${expectedRevision}
        RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(queryError),
      );
    }),
    deleteUnlessOwning: Effect.fn("BotStore.deleteUnlessOwning")((id, deletedAt) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const deleted = yield* sql<{ readonly id: string }>`
              UPDATE bots SET deleted_at = ${deletedAt}
              WHERE id = ${id} AND deleted_at IS NULL AND NOT EXISTS (
                SELECT 1 FROM projection_projects WHERE bot_id = ${id} AND deleted_at IS NULL
              )
              RETURNING id
            `;
            if (deleted.length > 0) return "deleted" as const;
            const existing = yield* sql`SELECT 1 FROM bots WHERE id = ${id} AND deleted_at IS NULL`;
            return existing.length > 0 ? ("owns-projects" as const) : ("missing" as const);
          }),
        )
        .pipe(Effect.mapError(queryError)),
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
      sql<{ readonly botId: string }>`
        SELECT bot_id AS "botId" FROM projection_projects
        WHERE project_id = ${projectId} AND deleted_at IS NULL
      `.pipe(
        Effect.map((rows) => rows[0]?.botId ?? null),
        Effect.mapError(queryError),
      ),
    ),
    firstOwnedProject: Effect.fn("BotStore.firstOwnedProject")((botId) =>
      sql<{ readonly projectId: string }>`
        SELECT project_id AS "projectId" FROM projection_projects
        WHERE bot_id = ${botId} AND deleted_at IS NULL
        ORDER BY created_at, project_id LIMIT 1
      `.pipe(
        Effect.map((rows) => rows[0]?.projectId ?? null),
        Effect.mapError(queryError),
      ),
    ),
  });
});

export const layer = Layer.effect(BotStore, make);
