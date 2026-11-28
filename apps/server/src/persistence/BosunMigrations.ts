import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
// A cycle, read only at run time: upstream's manifest decides which ledger rows are its own.
import { migrationManifest } from "./Migrations.ts";

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
import BotAvatars from "./Migrations/072_BotAvatars.ts";
import BotProjectGrants from "./Migrations/073_BotProjectGrants.ts";
import BuilderSubagents from "./Migrations/074_BuilderSubagents.ts";
import FeatureIssues from "./Migrations/075_FeatureIssues.ts";
import CaptainWorkflowGrant from "./Migrations/076_CaptainWorkflowGrant.ts";
import ScheduledTaskBots from "./Migrations/077_ScheduledTaskBots.ts";
import CaptainFullAccess from "./Migrations/078_CaptainFullAccess.ts";
import Tickets from "./Migrations/079_Tickets.ts";
import FeatureWorkflowSwitch from "./Migrations/080_FeatureWorkflowSwitch.ts";
import CrewWaitWithoutPolling from "./Migrations/081_CrewWaitWithoutPolling.ts";
import StageChecksInProportion from "./Migrations/082_StageChecksInProportion.ts";
import FeatureWorkspaces from "./Migrations/083_FeatureWorkspaces.ts";
import OneBuilderPerFeature from "./Migrations/084_OneBuilderPerFeature.ts";
import BotLongConversation from "./Migrations/086_BotLongConversation.ts";
import CrewFullAccess from "./Migrations/087_CrewFullAccess.ts";
import SlimFeatureDelivery from "./Migrations/088_SlimFeatureDelivery.ts";
import LeadDecisions from "./Migrations/089_LeadDecisions.ts";
import FeatureNumbers from "./Migrations/090_FeatureNumbers.ts";
import StageQuestions from "./Migrations/091_StageQuestions.ts";
import FeatureOpeningMessages from "./Migrations/092_FeatureOpeningMessages.ts";
import LeadAndCrew from "./Migrations/093_LeadAndCrew.ts";
import CrewRunBaseRef from "./Migrations/094_CrewRunBaseRef.ts";
import LeadWorkflows from "./Migrations/095_LeadWorkflows.ts";
import FeatureParents from "./Migrations/096_FeatureParents.ts";
import FeatureReports from "./Migrations/097_FeatureReports.ts";
import ProjectHandoffs from "./Migrations/098_ProjectHandoffs.ts";
import FeatureLeadRequester from "./Migrations/099_FeatureLeadRequester.ts";
import LinkedProjects from "./Migrations/100_LinkedProjects.ts";
import LinkedWorkflows from "./Migrations/101_LinkedWorkflows.ts";
import CrewMemberCustomized from "./Migrations/102_CrewMemberCustomized.ts";
import FeatureManager from "./Migrations/103_FeatureManager.ts";
import ProjectManagers from "./Migrations/104_ProjectManagers.ts";
import ProjectRequests from "./Migrations/105_ProjectRequests.ts";
import ProjectManagerHandoffs from "./Migrations/106_ProjectManagerHandoffs.ts";
import ProjectMergeNotices from "./Migrations/107_ProjectMergeNotices.ts";
import RemoveProjectBuilders from "./Migrations/108_RemoveProjectBuilders.ts";
import NoticeInbox from "./Migrations/109_NoticeInbox.ts";
import FeatureTagParent from "./Migrations/110_FeatureTagParent.ts";
import MergeClosedIssues from "./Migrations/111_MergeClosedIssues.ts";
import ProjectManagerOwnSettings from "./Migrations/112_ProjectManagerOwnSettings.ts";
import ProjectManagerIcon from "./Migrations/113_ProjectManagerIcon.ts";
import OptionalProjectBot from "./Migrations/114_OptionalProjectBot.ts";
import RailPins from "./Migrations/115_RailPins.ts";
import WithheldTools from "./Migrations/116_WithheldTools.ts";
import BotPermittedEnvironments from "./Migrations/117_BotPermittedEnvironments.ts";
import ProjectRemoteBot from "./Migrations/118_ProjectRemoteBot.ts";
import ScheduledTaskProjectManager from "./Migrations/119_ScheduledTaskProjectManager.ts";
import QuietNotices from "./Migrations/120_QuietNotices.ts";
import ProjectManagerHome from "./Migrations/121_ProjectManagerHome.ts";
import FullAccessAgents from "./Migrations/122_FullAccessAgents.ts";
import NoCanWorkOn from "./Migrations/123_NoCanWorkOn.ts";
import NoLongConversation from "./Migrations/124_NoLongConversation.ts";
import BotTransfers from "./Migrations/125_BotTransfers.ts";
import LibraryCopies from "./Migrations/126_LibraryCopies.ts";
import NoLeadRole from "./Migrations/127_NoLeadRole.ts";
import LibraryImports from "./Migrations/128_LibraryImports.ts";

const migrationEntries = [
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
  [72, "BotAvatars", BotAvatars],
  [73, "BotProjectGrants", BotProjectGrants],
  [74, "BuilderSubagents", BuilderSubagents],
  [75, "FeatureIssues", FeatureIssues],
  [76, "CaptainWorkflowGrant", CaptainWorkflowGrant],
  [77, "ScheduledTaskBots", ScheduledTaskBots],
  [78, "CaptainFullAccess", CaptainFullAccess],
  [79, "Tickets", Tickets],
  [80, "FeatureWorkflowSwitch", FeatureWorkflowSwitch],
  [81, "CrewWaitWithoutPolling", CrewWaitWithoutPolling],
  [82, "StageChecksInProportion", StageChecksInProportion],
  [83, "FeatureWorkspaces", FeatureWorkspaces],
  [84, "OneBuilderPerFeature", OneBuilderPerFeature],
  [86, "BotLongConversation", BotLongConversation],
  [87, "CrewFullAccess", CrewFullAccess],
  [88, "SlimFeatureDelivery", SlimFeatureDelivery],
  [89, "LeadDecisions", LeadDecisions],
  [90, "FeatureNumbers", FeatureNumbers],
  [91, "StageQuestions", StageQuestions],
  [92, "FeatureOpeningMessages", FeatureOpeningMessages],
  [93, "LeadAndCrew", LeadAndCrew],
  [94, "CrewRunBaseRef", CrewRunBaseRef],
  [95, "LeadWorkflows", LeadWorkflows],
  [96, "FeatureParents", FeatureParents],
  [97, "FeatureReports", FeatureReports],
  [98, "ProjectHandoffs", ProjectHandoffs],
  [99, "FeatureLeadRequester", FeatureLeadRequester],
  [100, "LinkedProjects", LinkedProjects],
  [101, "LinkedWorkflows", LinkedWorkflows],
  [102, "CrewMemberCustomized", CrewMemberCustomized],
  [103, "FeatureManager", FeatureManager],
  [104, "ProjectManagers", ProjectManagers],
  [105, "ProjectRequests", ProjectRequests],
  [106, "ProjectManagerHandoffs", ProjectManagerHandoffs],
  [107, "ProjectMergeNotices", ProjectMergeNotices],
  [108, "RemoveProjectBuilders", RemoveProjectBuilders],
  [109, "NoticeInbox", NoticeInbox],
  [110, "FeatureTagParent", FeatureTagParent],
  [111, "MergeClosedIssues", MergeClosedIssues],
  [112, "ProjectManagerOwnSettings", ProjectManagerOwnSettings],
  [113, "ProjectManagerIcon", ProjectManagerIcon],
  [114, "OptionalProjectBot", OptionalProjectBot],
  [115, "RailPins", RailPins],
  [116, "WithheldTools", WithheldTools],
  [117, "BotPermittedEnvironments", BotPermittedEnvironments],
  [118, "ProjectRemoteBot", ProjectRemoteBot],
  [119, "ScheduledTaskProjectManager", ScheduledTaskProjectManager],
  [120, "QuietNotices", QuietNotices],
  [121, "ProjectManagerHome", ProjectManagerHome],
  [122, "FullAccessAgents", FullAccessAgents],
  [123, "NoCanWorkOn", NoCanWorkOn],
  [124, "NoLongConversation", NoLongConversation],
  [125, "BotTransfers", BotTransfers],
  [126, "LibraryCopies", LibraryCopies],
  [127, "NoLeadRole", NoLeadRole],
  [128, "LibraryImports", LibraryImports],
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
/** Bosun's migrations share the folder with T3 Code's, under their own history table. */
export const bosunMigrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const tableExists = Effect.fn("BosunMigrations.tableExists")(function* (name: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`;
  return rows.length > 0;
});

// Upstream reuses names (its 110_Workflows), so a row of its own manifest is never Bosun's.
const legacyRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists("effect_sql_migrations"))) return [];
  const rows = yield* sql<{
    readonly migrationId: number;
    readonly name: string;
    readonly createdAt: string;
  }>`
    SELECT migration_id AS migrationId, name, created_at AS createdAt
    FROM effect_sql_migrations WHERE migration_id >= 55
  `;
  return rows.filter(
    (row) =>
      legacyNames.has(row.name) &&
      !migrationManifest.some(([id, name]) => id === row.migrationId && name === row.name),
  );
});

// Reads first: a current database must take no write lock, so CLI startup never contends
// with the running server (upstream's runMigrations makes the same promise).
export const reconcileLegacyHistory = Effect.fn("BosunMigrations.reconcileLegacyHistory")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    if ((yield* tableExists("bosun_sql_migrations")) && (yield* legacyRows).length === 0) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`CREATE TABLE IF NOT EXISTS bosun_sql_migrations (
      migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`;
        for (const row of yield* legacyRows) {
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
export const runMigrations = Effect.fn("BosunMigrations.runMigrations")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const entries = migrationEntries.filter(([id]) => throughId === undefined || id <= throughId);
  if (yield* tableExists("bosun_sql_migrations")) {
    const [latest] = yield* sql<{
      readonly id: number | null;
    }>`SELECT MAX(migration_id) AS id FROM bosun_sql_migrations`;
    const latestId = latest?.id ?? 0;
    // The Migrator runs ids above the latest recorded one; with none, it would only write.
    if (!entries.some(([id]) => id > latestId)) return [];
  }
  return yield* run({
    table: "bosun_sql_migrations",
    loader: Migrator.fromRecord(
      Object.fromEntries(entries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
    ),
  });
});
