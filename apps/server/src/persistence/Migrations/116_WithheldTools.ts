import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Agents store withheld tools instead of granted ones, keeping effective access: naming no T3
 * toolkit meant all of them, naming some meant only those, and "crew.workflows" was opt-in for
 * bots. Ids that granted nothing are dropped. Linked workflow snapshots convert too.
 */

const TOOLKITS = ["orchestration", "worktree", "pull-requests", "preview", "device"];
const MANAGE_CREW = "crew.workflows";

const asList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];

const parseList = (json: string): ReadonlyArray<string> => {
  try {
    return asList(JSON.parse(json));
  } catch {
    return [];
  }
};

/** A workflow snapshot's roles with withheld tools, or null when it isn't one to convert. */
const convertSnapshot = (snapshot: unknown): unknown => {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const roles = (snapshot as { roles?: unknown }).roles;
  if (!Array.isArray(roles)) return null;
  return {
    ...snapshot,
    roles: roles.map((role: unknown) => {
      if (typeof role !== "object" || role === null || !("allowedTools" in role)) return role;
      const { allowedTools, ...rest } = role as { allowedTools: unknown };
      return { ...rest, withheldTools: withheldFromList(asList(allowedTools), false) };
    }),
  };
};

const withheldJson = (allowedJson: string, bot: boolean): string =>
  JSON.stringify(withheldFromList(parseList(allowedJson), bot));

const withheldFromList = (allowed: ReadonlyArray<string>, bot: boolean) => {
  const limit = TOOLKITS.filter((toolkit) => allowed.includes(toolkit));
  return [
    ...(bot && !allowed.includes(MANAGE_CREW) ? [MANAGE_CREW] : []),
    ...(limit.length === 0 ? [] : TOOLKITS.filter((toolkit) => !limit.includes(toolkit))),
  ];
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hasTable = (table: string) =>
    sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  const hasBots = yield* hasTable("bots");

  for (const table of ["bots", "roles", "crew_members", "crew_runs"] as const) {
    if (!(yield* hasTable(table))) continue;
    // A run belongs to a bot when the bot acts in it.
    const rows =
      table === "bots"
        ? yield* sql<{ id: string; tools: string; bot: number }>`
            SELECT id, allowed_tools_json AS tools, 1 AS bot FROM bots
          `
        : table === "crew_runs" && hasBots
          ? yield* sql<{ id: string; tools: string; bot: number }>`
              SELECT id, allowed_tools_json AS tools,
                EXISTS (SELECT 1 FROM bots WHERE bots.id = crew_runs.member_id) AS bot
              FROM crew_runs
            `
          : yield* sql<{ id: string; tools: string; bot: number }>`
              SELECT id, allowed_tools_json AS tools, 0 AS bot FROM ${sql(table)}
            `;
    yield* sql`ALTER TABLE ${sql(table)} RENAME COLUMN allowed_tools_json TO withheld_tools_json`;
    for (const row of rows) {
      const withheld = withheldJson(row.tools, row.bot === 1);
      yield* sql`UPDATE ${sql(table)} SET withheld_tools_json = ${withheld} WHERE id = ${row.id}`;
    }
  }

  if (yield* hasTable("crew_run_workflows")) {
    const rows = yield* sql<{ id: string; json: string }>`
      SELECT run_id AS id, workflow_json AS json FROM crew_run_workflows
    `;
    for (const row of rows) {
      const json = rewriteJson(row.json, (linked) => {
        if (typeof linked !== "object" || linked === null || !("snapshot" in linked)) return null;
        const snapshot = convertSnapshot(linked.snapshot);
        return snapshot === null ? null : { ...linked, snapshot };
      });
      if (json !== null) {
        yield* sql`UPDATE crew_run_workflows SET workflow_json = ${json} WHERE run_id = ${row.id}`;
      }
    }
  }
  const featureColumns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('features')`;
  if (featureColumns.some((column) => column.name === "workflow_snapshot_json")) {
    const rows = yield* sql<{ id: string; json: string }>`
      SELECT id, workflow_snapshot_json AS json FROM features
      WHERE workflow_snapshot_json IS NOT NULL
    `;
    for (const row of rows) {
      const json = rewriteJson(row.json, convertSnapshot);
      if (json !== null) {
        yield* sql`UPDATE features SET workflow_snapshot_json = ${json} WHERE id = ${row.id}`;
      }
    }
  }
});

const rewriteJson = (json: string, convert: (value: unknown) => unknown): string | null => {
  try {
    const converted = convert(JSON.parse(json));
    return converted === null ? null : JSON.stringify(converted);
  } catch {
    return null;
  }
};
