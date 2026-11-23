import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  bootstrapKey, compareChecksums, connectDatabase, migrationFilename,
  migrationsDirectory, readLedger, readSourceMigrations,
} from "./check-database.mjs";

const usage = "Usage: prod-apply-migrations.sh [--list | --dry-run | --apply] [--manifest FILE]";
const defaultManifest = join(migrationsDirectory, "release-2.3.0.manifest");

// Preserve the release boundaries and order that existing installations used.
const frozenManifests = new Map([
  ["release-2.2.0.manifest", "472fbd996b02bca3229b9b3cd1085c7e3d5abe4d280d31f1bf1e920519087c19"],
  ["release-2.2.0.prerequisites.manifest", "15998d71fd66ff2e42756b977aa6cafaf606561cab30d778df1ce1dab0ada910"],
  ["release-2.2.1.manifest", "be5579753a13dd60d9f997652963a22ff9e18276bce4b6f96194ea98a43b10ab"],
  ["release-2.2.1.prerequisites.manifest", "a6ce0e65fa42fc2e07b3ca4ebebcd5dbe6216fa5097a815dfdf882dcad77a34e"],
  ["release-2.2.2.manifest", "a039eeb7b76f7ce6099b09f04b06a716f3eb6d9b3dcfe12d825cdb57fcc37fd5"],
  ["release-2.2.2.prerequisites.manifest", "48248548ca655101e3529f08cfcbda91ef7e8ab093dae4aaafe2070bcabcb1a3"],
  ["release-2.2.3.manifest", "45e3d7c6b31b44e3c9f6fb45864acecea6abe11f1f3a26034d46c2680b50693d"],
  ["release-2.2.3.prerequisites.manifest", "4bfc1f9bc4e7743bbb18313ccd7cfd6875cb8a6e766623efa00f8c12e82a7cc0"],
  ["release-2.3.0.manifest", "a111938c2c371451dc2fa116f351a86ae2760fcddbde8492607ed92157145a15"],
  ["release-2.3.0.prerequisites.manifest", "a7e306dfd9643255d944e65345970d3eb21d307a76e8f65a1cc3f5cd68301c7f"],
]);

function parseArgs(args) {
  let manifest = process.env.MIGRATION_MANIFEST_FILE || defaultManifest;
  let mode;
  while (args.length) {
    const flag = args.shift();
    switch (flag) {
      case "--list":
      case "--dry-run":
      case "--apply":
        if (mode) throw Error(usage);
        mode = flag;
        break;
      case "--manifest":
        manifest = args.shift();
        if (!manifest) throw Error(usage);
        break;
      case "--database-url": {
        const url = args.shift();
        if (!url) throw Error(usage);
        process.env.MIGRATION_DATABASE_URL = url;
        break;
      }
      default:
        throw Error(usage);
    }
  }
  return { manifest: resolve(manifest), mode };
}

function readManifest(path, source) {
  if (!lstatSync(path).isFile()) throw Error("Expected a regular manifest file: " + basename(path));
  const bytes = readFileSync(path);
  const frozenChecksum = frozenManifests.get(basename(path));
  if (frozenChecksum && createHash("sha256").update(bytes).digest("hex") !== frozenChecksum) {
    throw Error("Release manifest checksum mismatch: " + basename(path));
  }
  const rows = bytes.toString("utf8").split(/\r?\n/).filter(line => line && !line.startsWith("#"));
  if (!rows.length) throw Error("Empty migration manifest: " + basename(path));
  return rows.map((row, index) => {
    const [order, name, checksum, policy, ...extra] = row.split("|");
    if (extra.length || order !== String(index + 1) || !migrationFilename.test(name)
      || source.get(name)?.checksum !== checksum || policy !== "required") {
      throw Error("Invalid or drifted release manifest " + basename(path) + " at row " + order);
    }
    return name;
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(usage + "\nSet MIGRATION_DATABASE_URL. Default mode checks, exiting 2 for pending migrations. --apply requires MIGRATION_WRITERS_FENCED=true.");
    return;
  }
  const { mode, manifest } = parseArgs(args);
  const apply = mode === "--apply";
  if (!/^release-\d+\.\d+\.\d+\.manifest$/.test(basename(manifest))) throw Error("Expected a release migration manifest");
  const source = readSourceMigrations();
  const required = [bootstrapKey, "000_schema_migrations_ledger.sql",
    ...readManifest(join(dirname(manifest), basename(manifest, ".manifest") + ".prerequisites.manifest"), source)];
  const delta = readManifest(manifest, source);
  const all = [...required, ...delta];
  const keys = new Set(all);
  if (all.length !== keys.size) throw Error("Duplicate release migration");
  const last = delta[delta.length - 1];
  const expected = [...source.keys()].filter(key => key === bootstrapKey || key <= last);
  if (expected.length !== keys.size || expected.some(key => !keys.has(key))) throw Error("Incomplete release migration coverage");
  if (apply && process.env.MIGRATION_WRITERS_FENCED !== "true") throw Error("Stop all writers and set MIGRATION_WRITERS_FENCED=true before applying migrations");

  const client = await connectDatabase();
  try {
    await client.query(apply ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const [setting, value] of [
      ["lock_timeout", process.env.MIGRATION_LOCK_TIMEOUT || "5s"],
      ["statement_timeout", process.env.MIGRATION_STATEMENT_TIMEOUT || "15min"],
      ["idle_in_transaction_session_timeout", process.env.MIGRATION_IDLE_TX_TIMEOUT || "60s"],
    ]) {
      await client.query("SELECT set_config($1,$2,true)", [setting, value]);
    }
    if (apply) await client.query("SELECT pg_advisory_xact_lock(hashtextextended('snus-custom-migration-runner-v2', 0))");
    const ledger = await readLedger(client);
    compareChecksums(source, ledger);
    for (const key of ledger.keys()) {
      if (!keys.has(key)) throw Error("Database is ahead of this release: " + key);
    }
    for (const key of required) {
      if (!ledger.has(key)) throw Error("Release prerequisite missing: " + key);
    }
    const pending = delta.filter(key => !ledger.has(key));
    if (pending.length && delta.slice(delta.indexOf(pending[0])).some(key => ledger.has(key))) {
      throw Error("Migration history has a gap within this release");
    }
    if (apply && pending.length) {
      const active = await client.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND pid<>pg_backend_pid() AND backend_type='client backend' AND state<>'idle' LIMIT 1`);
      if (active.rowCount) throw Error("Another database transaction is active; verify the write fence");
      for (const key of pending) {
        const migration = source.get(key);
        const sql = migration.bytes.toString("utf8");
        if (/^\s*(BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION|(?:COMMIT|ROLLBACK)(?:\s+(?:WORK|TRANSACTION))?)\s*;/im.test(sql)) {
          throw Error("Transaction control in release migration: " + key);
        }
        await client.query(sql);
        await client.query("INSERT INTO app.schema_migrations (filename, checksum) VALUES ($1, $2)", [key, migration.checksum]);
      }
    }
    await client.query("COMMIT");
    if (pending.length) console.log((apply ? "Applied" : "Pending") + " (" + pending.length + "):\n" + pending.join("\n"));
    else console.log("This release is already recorded; no migrations to apply.");
    // An older deployment wrapper may assume a zero exit means migrations were applied.
    if (!mode && pending.length) process.exitCode = 2;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
