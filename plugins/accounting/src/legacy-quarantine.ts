const ENABLE_ENV = "ALLOW_LEGACY_ACCOUNTING_PLUGIN";

export function assertLegacyAccountingPluginAllowed(): void {
  if (process.env[ENABLE_ENV] === "true") return;

  throw new Error(
    `plugins/accounting is legacy in-memory code and is not production-safe. ` +
      `Use src/api/accounting/* with the PostgreSQL-backed application service instead, ` +
      `or set ${ENABLE_ENV}=true only for local legacy tests.`,
  );
}
