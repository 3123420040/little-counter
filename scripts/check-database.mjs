import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

export const migrationsDirectory = fileURLToPath(new URL("../db/migrations/", import.meta.url));
export const bootstrapKey = "bootstrap/custom-migration-prerequisites.sql";
export const migrationFilename = /^[0-9]{3}_[a-z0-9_]+\.sql$/;

export function readSourceMigrations() {
  const files = new Map();
  const add = (key, path) => {
    if (!lstatSync(path).isFile()) throw Error("Expected a regular migration file: " + key);
    const bytes = readFileSync(path);
    files.set(key, { checksum: createHash("sha256").update(bytes).digest("hex"), bytes });
  };
  add(bootstrapKey, resolve(migrationsDirectory, "..", "custom-migration-prerequisites.sql"));
  for (const name of readdirSync(migrationsDirectory).sort()) {
    if (name.endsWith(".sql")) {
      if (!migrationFilename.test(name)) throw Error("Unexpected migration filename: " + name);
      add(name, join(migrationsDirectory, name));
    }
  }
  if (files.size < 2) throw Error("No numbered SQL migrations found");
  return files;
}

export async function connectDatabase(connectionString = process.env.MIGRATION_DATABASE_URL) {
  if (!connectionString) throw Error("Set MIGRATION_DATABASE_URL to the explicit target database");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
  await client.connect();
  return client;
}

export async function readLedger(client) {
  const { rows: [schema] } = await client.query(
    "SELECT to_regclass('public.stock_location') AS core, to_regclass('app.schema_migrations') AS ledger",
  );
  if (!schema.core || !schema.ledger) throw Error("Existing Medusa core and custom migration ledger are required");
  const { rows } = await client.query("SELECT filename, checksum FROM app.schema_migrations ORDER BY filename");
  return new Map(rows.map(({ filename, checksum }) => [filename, checksum]));
}

// Medusa creates these defaults during startup if it cannot find an existing row.
export async function requireCoreDefaults(client) {
  const { rows: [defaults] } = await client.query(`
    SELECT EXISTS (SELECT 1 FROM public.store WHERE deleted_at IS NULL) AS store,
           EXISTS (SELECT 1 FROM public.sales_channel WHERE deleted_at IS NULL) AS sales_channel,
           EXISTS (SELECT 1 FROM public.api_key WHERE type = 'publishable' AND deleted_at IS NULL) AS publishable_key
  `);
  const missing = Object.keys(defaults).filter(name => !defaults[name]);
  if (missing.length) {
    throw Error("Restored database is missing Medusa defaults: " + missing.join(", ") +
      ". Starting Medusa would create data. Verify the restored database before starting.");
  }
}

export function compareChecksums(source, ledger) {
  for (const [name, recorded] of ledger) {
    if (!source.has(name)) throw Error("Database contains a migration missing from this checkout: " + name);
    if (source.get(name).checksum !== recorded) throw Error("Checksum mismatch: " + name);
  }
  return [...source.keys()].filter(name => !ledger.has(name));
}

async function check() {
  if (process.argv.length > 2) throw Error("Usage: node scripts/check-database.mjs (requires MIGRATION_DATABASE_URL)");
  const source = readSourceMigrations();
  const client = await connectDatabase();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const ledger = await readLedger(client);
    const pending = compareChecksums(source, ledger);
    if (!pending.length) await requireCoreDefaults(client);
    await client.query("COMMIT");
    if (pending.length) {
      console.error("Pending migrations (" + pending.length + "):\n" + pending.join("\n"));
      process.exitCode = 2;
    } else {
      console.log("All " + ledger.size + " custom migration checksums match this checkout.");
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  check().catch(error => { console.error(error.message); process.exitCode = 1; });
}
