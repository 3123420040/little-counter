import {
  compareChecksums, connectDatabase, readLedger, readSourceMigrations, requireCoreDefaults,
} from "./check-database.mjs";

async function checkRestoredDatabase() {
  if (!process.env.DATABASE_URL) throw Error("Set DATABASE_URL to the restored application database");
  const client = await connectDatabase(process.env.DATABASE_URL);
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await requireCoreDefaults(client);
    const { rows: [catalog] } = await client.query(`
      SELECT ledger IS NOT NULL AS has_ledger,
             has_table_privilege(current_user, ledger, 'SELECT') AS can_read
      FROM (SELECT to_regclass('app.schema_migrations') AS ledger) existing
    `);
    if (!catalog.has_ledger) throw Error("Restored application migration ledger is missing");
    if (catalog.can_read) {
      const pending = compareChecksums(readSourceMigrations(), await readLedger(client));
      if (pending.length) throw Error("Restored application database has pending migrations: " + pending.join(", "));
    } else {
      console.log("Runtime role has limited ledger access. Use npm run db:check with an operator credential to verify checksums.");
    }
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
}

checkRestoredDatabase().catch(error => { console.error(error.message); process.exitCode = 1; });
