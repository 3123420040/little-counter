const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const DATABASE_NAME = /^[a-z0-9][a-z0-9_-]*_test$/i;
const COMPOSE_PROJECT = /^medusa-snus-v19-[a-z0-9][a-z0-9-]{0,47}$/;
const RUN_ID = /^V19-UAT-[A-Z0-9-]{4,64}$/;
const SHARED_DATABASE_PORTS = new Set(["5432", "5433"]);

export const LOCAL_TEST_DATABASE_SENTINEL = "medusa-snus-v1.9-disposable-v1";

export type SafeTestDatabaseTarget = {
  connectionString: string;
  databaseName: string;
  hostname: string;
  port: string;
  composeProject: string;
  volumeName: string;
  runId: string;
  sentinel: typeof LOCAL_TEST_DATABASE_SENTINEL;
};

export type DatabaseQueryable = {
  query: <T extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rowCount: number | null; rows: T[] }>;
};

export function redactDatabaseTarget(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch {
    return "invalid-database-url";
  }
}

/**
 * Database qualification performs DDL and fixture writes. Refuse to return a
 * target unless the caller proves a dedicated v1.9 loopback project, port,
 * volume, run, and sentinel. This is intentionally stricter than a generic
 * developer database configuration.
 */
export function requireSafeTestDatabaseTarget(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SafeTestDatabaseTarget {
  if (!value) {
    throw new Error("TEST_DATABASE_URL must be set explicitly for database tests");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must use the postgres or postgresql protocol");
  }

  const hostname = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("TEST_DATABASE_URL must target a loopback PostgreSQL host");
  }

  const port = url.port;
  if (!port || SHARED_DATABASE_PORTS.has(port)) {
    throw new Error("TEST_DATABASE_URL must use an explicit dedicated non-default port");
  }
  if (!env.TEST_DATABASE_PORT || env.TEST_DATABASE_PORT !== port) {
    throw new Error("TEST_DATABASE_URL port must match TEST_DATABASE_PORT");
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!DATABASE_NAME.test(databaseName)) {
    throw new Error("TEST_DATABASE_URL database name must end with _test");
  }

  if (env.TEST_DATABASE_SENTINEL !== LOCAL_TEST_DATABASE_SENTINEL) {
    throw new Error("TEST_DATABASE_SENTINEL sentinel mismatch");
  }

  const composeProject = env.TEST_COMPOSE_PROJECT || "";
  if (!COMPOSE_PROJECT.test(composeProject) || composeProject === "medusa-snus-test") {
    throw new Error("TEST_COMPOSE_PROJECT must name a dedicated v1.9 compose project");
  }

  const volumeName = env.TEST_DATABASE_VOLUME || "";
  if (volumeName !== `${composeProject}-postgres-data`) {
    throw new Error("TEST_DATABASE_VOLUME must name the dedicated compose volume");
  }

  const runId = env.TEST_DATABASE_RUN_ID || "";
  if (!RUN_ID.test(runId)) {
    throw new Error("TEST_DATABASE_RUN_ID must be a v1.9 UAT run ID");
  }

  return {
    connectionString: value,
    databaseName,
    hostname,
    port,
    composeProject,
    volumeName,
    runId,
    sentinel: LOCAL_TEST_DATABASE_SENTINEL,
  };
}

export async function assertSafeTestDatabaseSentinel(
  database: DatabaseQueryable,
  target: SafeTestDatabaseTarget,
): Promise<void> {
  const result = await database.query<{
    database_name: string;
    marker: string;
    compose_project: string;
    volume_name: string;
    run_id: string;
  }>(
    `SELECT database_name, marker, compose_project, volume_name, run_id
       FROM app.local_test_database_sentinels
      WHERE database_name = current_database()
        AND marker = $1
        AND compose_project = $2
        AND volume_name = $3
        AND run_id = $4`,
    [target.sentinel, target.composeProject, target.volumeName, target.runId],
  );
  if (result.rowCount !== 1) {
    throw new Error("Disposable test database sentinel does not match the guarded target");
  }
}
