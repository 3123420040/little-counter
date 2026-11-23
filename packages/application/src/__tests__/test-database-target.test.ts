import { describe, expect, it } from "vitest";
import {
  LOCAL_TEST_DATABASE_SENTINEL,
  assertSafeTestDatabaseSentinel,
  redactDatabaseTarget,
  requireSafeTestDatabaseTarget,
} from "../db/test-database-target";

function databaseUrl(overrides: {
  protocol?: string;
  hostname?: string;
  port?: string;
  databaseName?: string;
} = {}): string {
  const protocol = overrides.protocol ?? "postgresql:";
  const hostname = overrides.hostname ?? "127.0.0.1";
  const port = overrides.port ?? "55439";
  const databaseName = overrides.databaseName ?? "medusa_snus_v19_test";
  return `${protocol}//test_operator:${"x".repeat(32)}@${hostname}:${port}/${databaseName}?sslmode=disable`;
}

function safeEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TEST_DATABASE_SENTINEL: LOCAL_TEST_DATABASE_SENTINEL,
    TEST_DATABASE_RUN_ID: "V19-UAT-01A05B87",
    TEST_DATABASE_PORT: "55439",
    TEST_COMPOSE_PROJECT: "medusa-snus-v19-uat",
    TEST_DATABASE_VOLUME: "medusa-snus-v19-uat-postgres-data",
    ...overrides,
  };
}

describe("test database target guard", () => {
  it("accepts an explicitly isolated v1.9 loopback test database", () => {
    const value = databaseUrl();

    expect(requireSafeTestDatabaseTarget(value, safeEnvironment())).toEqual({
      connectionString: value,
      databaseName: "medusa_snus_v19_test",
      hostname: "127.0.0.1",
      port: "55439",
      composeProject: "medusa-snus-v19-uat",
      volumeName: "medusa-snus-v19-uat-postgres-data",
      runId: "V19-UAT-01A05B87",
      sentinel: LOCAL_TEST_DATABASE_SENTINEL,
    });
  });

  it.each([
    ["missing URL", undefined, safeEnvironment(), "set explicitly"],
    ["invalid URL", "not-a-url", safeEnvironment(), "valid PostgreSQL URL"],
    ["wrong protocol", databaseUrl({ protocol: "https:" }), safeEnvironment(), "postgres or postgresql protocol"],
    ["remote host", databaseUrl({ hostname: "db.example.test" }), safeEnvironment(), "loopback PostgreSQL host"],
    ["shared local port", databaseUrl({ port: "5433" }), safeEnvironment({ TEST_DATABASE_PORT: "5433" }), "dedicated non-default port"],
    ["port mismatch", databaseUrl(), safeEnvironment({ TEST_DATABASE_PORT: "55440" }), "must match TEST_DATABASE_PORT"],
    ["wrong database suffix", databaseUrl({ databaseName: "medusa_snus_v19" }), safeEnvironment(), "end with _test"],
    ["missing sentinel", databaseUrl(), safeEnvironment({ TEST_DATABASE_SENTINEL: "" }), "sentinel mismatch"],
    ["wrong sentinel", databaseUrl(), safeEnvironment({ TEST_DATABASE_SENTINEL: "another-marker" }), "sentinel mismatch"],
    ["shared compose project", databaseUrl(), safeEnvironment({ TEST_COMPOSE_PROJECT: "medusa-snus-test" }), "dedicated v1.9 compose project"],
    ["invalid volume", databaseUrl(), safeEnvironment({ TEST_DATABASE_VOLUME: "shared-postgres-data" }), "dedicated compose volume"],
    ["invalid run id", databaseUrl(), safeEnvironment({ TEST_DATABASE_RUN_ID: "local" }), "v1.9 UAT run ID"],
  ])("rejects %s before a database command is built", (_label, value, env, message) => {
    expect(() => requireSafeTestDatabaseTarget(value, env)).toThrow(message);
  });

  it("redacts credentials and query parameters from diagnostics", () => {
    expect(redactDatabaseTarget(databaseUrl())).toBe(
      "postgresql://127.0.0.1:55439/medusa_snus_v19_test",
    );
    expect(redactDatabaseTarget("not-a-url")).toBe("invalid-database-url");
  });

  it("requires one database sentinel row matching the guarded identity", async () => {
    const target = requireSafeTestDatabaseTarget(databaseUrl(), safeEnvironment());
    const query = async (_text: string, values?: unknown[]) => ({
      rowCount: values?.join("|") === [
        target.sentinel,
        target.composeProject,
        target.volumeName,
        target.runId,
      ].join("|") ? 1 : 0,
      rows: [],
    });

    await expect(assertSafeTestDatabaseSentinel({ query }, target)).resolves.toBeUndefined();
    await expect(assertSafeTestDatabaseSentinel({
      query: async () => ({ rowCount: 0, rows: [] }),
    }, target)).rejects.toThrow("sentinel does not match");
  });
});
