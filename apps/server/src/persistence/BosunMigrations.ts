import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Bots from "./Migrations/055_Bots.ts";
import BotHandoffs from "./Migrations/056_BotHandoffs.ts";
import BotStorageNames from "./Migrations/057_BotStorageNames.ts";
import BotTemplates from "./Migrations/058_BotTemplates.ts";
import BotHierarchy from "./Migrations/059_BotHierarchy.ts";

import Workflows from "./Migrations/060_Workflows.ts";

import WorkflowStepEvents from "./Migrations/061_WorkflowStepEvents.ts";

import BotHandoffReceipts from "./Migrations/063_BotHandoffReceipts.ts";

import WorkflowExecutions from "./Migrations/064_WorkflowExecutions.ts";

import Features from "./Migrations/062_Features.ts";

import ReconcileFeatureStorage from "./Migrations/065_ReconcileFeatureStorage.ts";

import FeatureLifecycle from "./Migrations/066_FeatureLifecycle.ts";
import CrewLifecycle from "./Migrations/067_CrewLifecycle.ts";

import WorkflowStageHandoffs from "./Migrations/068_WorkflowStageHandoffs.ts";
import AttachedStageThreads from "./Migrations/069_AttachedStageThreads.ts";
import CrewRoles from "./Migrations/070_CrewRoles.ts";
import TopLevelBots from "./Migrations/071_TopLevelBots.ts";

export const migrationEntries = [
  [55, "Bots", Bots],
  [56, "BotHandoffs", BotHandoffs],
  [57, "BotStorageNames", BotStorageNames],
  [58, "BotTemplates", BotTemplates],
  [59, "BotHierarchy", BotHierarchy],
  [60, "Workflows", Workflows],
  [61, "WorkflowStepEvents", WorkflowStepEvents],
  [62, "Features", Features],
  [63, "BotHandoffReceipts", BotHandoffReceipts],
  [64, "WorkflowExecutions", WorkflowExecutions],
  [65, "ReconcileFeatureStorage", ReconcileFeatureStorage],
  [66, "FeatureLifecycle", FeatureLifecycle],
  [67, "CrewLifecycle", CrewLifecycle],
  [68, "WorkflowStageHandoffs", WorkflowStageHandoffs],
  [69, "AttachedStageThreads", AttachedStageThreads],
  [70, "CrewRoles", CrewRoles],
  [71, "TopLevelBots", TopLevelBots],
] as const;

const legacyNames = new Set([
  "BosunBots",
  "BosunHandoffs",
  "Bots",
  "BotHandoffs",
  "BotStorageNames",
  "BotTemplates",
  "BotHierarchy",
  "BotFeatures",
  "Workflows",
  "WorkflowStepEvents",
  "Features",
  "BotHandoffReceipts",
  "WorkflowExecutions",
  "ReconcileFeatureStorage",
  "FeatureLifecycle",
  "CrewLifecycle",
  "FeatureLaunches",
  "FeatureExecution",
  "FeatureCheckoutSetup",
]);

// Keep upstream's numbered ledger free for upstream migrations. Move only known
// Bosun entries; their schemas and timestamps stay intact in the domain ledger.
export const reconcileLegacyHistory = Effect.fn("BosunMigrations.reconcileLegacyHistory")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`CREATE TABLE IF NOT EXISTS bosun_sql_migrations (
      migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`;
        const tables =
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
        if (tables.length === 0) return;
        const rows = yield* sql<{
          readonly migrationId: number;
          readonly name: string;
          readonly createdAt: string;
        }>`
      SELECT migration_id AS migrationId, name, created_at AS createdAt
      FROM effect_sql_migrations WHERE migration_id >= 55
    `;
        for (const row of rows) {
          if (!legacyNames.has(row.name)) continue;
          yield* sql`INSERT INTO bosun_sql_migrations (migration_id, name, created_at)
        VALUES (${row.migrationId}, ${row.name}, ${row.createdAt})
        ON CONFLICT (migration_id) DO UPDATE SET name = excluded.name, created_at = excluded.created_at`;
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${row.migrationId} AND name = ${row.name}`;
        }
      }),
    );
  },
);

const run = Migrator.make({});
export const runMigrations = (throughId?: number) =>
  run({
    table: "bosun_sql_migrations",
    loader: Migrator.fromRecord(
      Object.fromEntries(
        migrationEntries
          .filter(([id]) => throughId === undefined || id <= throughId)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
