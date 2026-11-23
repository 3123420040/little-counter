export function getPlatformDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required");
  return url;
}

/**
 * Production report reads use a separate, read-only database credential.
 * Local and test processes fall back to the primary connection so the
 * developer workflow does not require provisioning an extra role.
 */
export function getReportDatabaseUrl(): string {
  return process.env.REPORT_DATABASE_URL || getPlatformDatabaseUrl();
}
