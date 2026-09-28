// Convert an authenticated JSON export into SQL for a NEW, migrated D1 database.
// The generated file contains private data. Keep it outside the repository.
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const columns = {
  projects: ["id", "name", "purpose", "repository_url", "scope", "version", "created_at", "updated_at", "updated_by"],
  milestones: ["id", "project_id", "goal", "acceptance", "check_date", "state", "version", "created_at", "updated_at", "updated_by"],
  work_items: ["id", "project_id", "title", "next_action", "check_date", "state", "version", "created_at", "updated_at", "updated_by", "milestone_id"],
  events: ["id", "entity_type", "entity_id", "operation", "actor", "at_utc", "before_json", "after_json"],
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states = new Set(["未確認", "進行中", "待ち", "完了", "保留"]);
function fail(message) { throw new Error(message); }
function exactKeys(row, expected) {
  return row && typeof row === "object" && !Array.isArray(row) &&
    Object.keys(row).sort().join() === [...expected].sort().join();
}
function string(value, max = 4000) {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) fail("invalid_string");
  return value;
}
function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail("invalid_integer");
  return value;
}
function sql(value) {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(positive(value));
  return `'${string(value).replaceAll("'", "''")}'`;
}
function validateRows(backup) {
  for (const [table, expected] of Object.entries(columns)) {
    if (!Array.isArray(backup[table])) fail(`invalid_${table}`);
    for (const row of backup[table]) {
      if (!exactKeys(row, expected)) fail(`invalid_${table}_row`);
      for (const column of expected) {
        if (column === "milestone_id" || column === "before_json") {
          if (row[column] !== null) string(row[column]);
        } else if (column === "version" || table === "events" && column === "id") positive(row[column]);
        else string(row[column]);
      }
      if (table !== "events" && !uuid.test(row.id)) fail("invalid_id");
      if (table === "events") {
        if (!["project", "milestone", "work_item"].includes(row.entity_type) ||
            !["create", "update"].includes(row.operation) || !uuid.test(row.entity_id)) fail("invalid_event");
        if (row.before_json !== null) JSON.parse(row.before_json);
        JSON.parse(row.after_json);
      }
      if (table === "projects" && !["personal", "hybrid"].includes(row.scope)) fail("invalid_scope");
      if ((table === "milestones" || table === "work_items") && !states.has(row.state)) fail("invalid_state");
    }
  }
  const projectIds = new Set(backup.projects.map((row) => row.id));
  const milestoneIds = new Set(backup.milestones.map((row) => row.id));
  for (const table of ["milestones", "work_items"]) {
    const ids = new Set();
    for (const row of backup[table]) {
      if (ids.has(row.id) || !projectIds.has(row.project_id)) fail(`invalid_${table}_relation`);
      ids.add(row.id);
    }
  }
  if (projectIds.size !== backup.projects.length) fail("duplicate_project");
  for (const row of backup.work_items) {
    if (row.milestone_id !== null &&
        (!milestoneIds.has(row.milestone_id) ||
         backup.milestones.find((milestone) => milestone.id === row.milestone_id)?.project_id !== row.project_id)) {
      fail("invalid_milestone_relation");
    }
  }
  if (new Set(backup.events.map((row) => row.id)).size !== backup.events.length) fail("duplicate_event");
}

async function main() {
  if (process.argv.length !== 4) fail("usage: node restore-json.mjs <backup.json> <output.sql>");
  const input = resolve(process.argv[2]);
  const output = resolve(process.argv[3]);
  const location = relative(repo, output);
  if (!location || (!location.startsWith("..") && !isAbsolute(location))) fail("output_must_be_outside_repository");
  if ((await stat(input)).size > 100_000_000) fail("backup_too_large");
  const backup = JSON.parse(await readFile(input, "utf8"));
  if (backup.format !== "deskly-personal-d1-v2" || !string(backup.exported_at, 40)) fail("invalid_format");
  validateRows(backup);
  const lines = ["-- Private restore for an EMPTY D1 database after migrations 0001 and 0002.",
    "-- Each guard is a self-insert: it is a no-op on an empty table and fails on an existing row.",
    "-- All guards run before any backup data is inserted or events are deleted."];
  for (const table of ["projects", "milestones", "work_items", "events"]) {
    lines.push(`INSERT INTO ${table} (${columns[table].join(",")}) ` +
      `SELECT ${columns[table].join(",")} FROM ${table} LIMIT 1;`);
  }
  for (const table of ["projects", "milestones", "work_items"]) {
    for (const row of backup[table]) lines.push(`INSERT INTO ${table} (${columns[table].join(",")}) VALUES (${columns[table].map((key) => sql(row[key])).join(",")});`);
  }
  lines.push("DELETE FROM events;");
  for (const row of backup.events) {
    lines.push(`INSERT INTO events (${columns.events.join(",")}) VALUES (${columns.events.map((key) => sql(row[key])).join(",")});`);
  }
  await writeFile(output, lines.join("\n") + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`SQL prepared for a new D1 database: ${backup.projects.length} projects, ` +
    `${backup.milestones.length} milestones, ${backup.work_items.length} items, ${backup.events.length} events.\n`);
}
main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
