import { beforeEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ database: vi.fn(), readiness: vi.fn(), query: vi.fn() }));
vi.mock("../partner/control-database", () => ({ withControlDatabase: ports.database }));
vi.mock("../partner/platform-mcp-readiness", async importOriginal => ({ ...await importOriginal<object>(), loadPlatformMcpProductionReadinessV1: ports.readiness }));
import { issuePlatformMcpKey, rotatePlatformMcpKey, createPlatformMcpConnection, changePlatformMcpConnectionStatus } from "../partner/platform-mcp-control";
const actor = { operatorId: "synthetic-admin", displayName: "Synthetic", role: "owner", authState: "authenticated", sessionVersion: 1,
  sessionExpiresAt: "2099-01-01T00:00:00.000Z" } as const;
const input = { expectedIntegrationVersion: 1, expectedAuthorizationSnapshotSha256: "a".repeat(64), reason: "onboarding" };
const headers = { "idempotency-key": "synthetic-stable-key-request" };
let activeTransaction: boolean, allowed: boolean, keyScopes: string[], finishCommit: () => void, failCommit: (error: Error) => void;
beforeEach(() => {
  vi.clearAllMocks(); activeTransaction = false; allowed = true; keyScopes = ["partner:read"];
  ports.query.mockImplementation(async (sql: string) => {
    if (sql.includes("lock_platform_mcp_admin")) return { rowCount: 1, rows: [{ allowed }] };
    if (sql.includes("partner_mcp_keys")) return { rowCount: 1, rows: [{ scopes: keyScopes }] };
    return { rowCount: 1, rows: [{ id: "integration-a" }] };
  });
  ports.readiness.mockImplementation(async () => { expect(activeTransaction).toBe(false); return undefined; });
  let calls = 0;
  ports.database.mockImplementation(async (_write, work) => {
    calls++;
    if (calls % 2 === 1) {
      activeTransaction = true;
      try { return await work({ query: ports.query }, "production"); } finally { activeTransaction = false; }
    }
    // Simulates the COMMIT-owning database port; registry mutation is tested against PostgreSQL separately.
    await new Promise<void>((resolve, reject) => { finishCommit = resolve; failCommit = reject; });
    return { data: { integrationId: "integration-a" }, replayed: false, revealedKey: "synthetic-local-only-key" };
  });
});
describe("MCP key command admission and COMMIT boundary", () => {
  it.each(["create", "resume"])("defaults %s to read and keeps its result behind COMMIT", async operation => {
    const call = operation === "create" ? createPlatformMcpConnection(actor, "merchant-a", { name: "Synthetic", storeIds: ["store-a"], reason: "onboarding" }, headers)
      : changePlatformMcpConnectionStatus(actor, "merchant-a", "integration-a", { ...input, status: "active" }, headers);
    const resolved = vi.fn(), pending = call.then(value => { resolved(value); return value; });
    await vi.waitFor(() => expect(ports.database).toHaveBeenCalledTimes(2));
    expect(ports.readiness).toHaveBeenCalledWith("read"); expect(resolved).not.toHaveBeenCalled();
    finishCommit(); await pending;
  });
  it.each(["create", "resume"])("denies a freshly unauthorized %s before readiness IO", async operation => {
    allowed = false;
    const pending = operation === "create" ? createPlatformMcpConnection(actor, "merchant-a", { name: "Synthetic", storeIds: ["store-a"], reason: "onboarding" }, headers)
      : changePlatformMcpConnectionStatus(actor, "merchant-a", "integration-a", { ...input, status: "active" }, headers);
    await expect(pending).rejects.toMatchObject({ code: "forbidden" }); expect(ports.readiness).not.toHaveBeenCalled();
  });
  it("checks fresh platform admin before any private readiness IO", async () => {
    allowed = false;
    await expect(issuePlatformMcpKey(actor, "merchant-a", "integration-a", input, headers)).rejects.toMatchObject({ code: "forbidden" });
    expect(ports.readiness).not.toHaveBeenCalled(); expect(ports.database).toHaveBeenCalledTimes(1);
  });
  it("performs probes outside a transaction and never resolves the key before the database port commits", async () => {
    const resolved = vi.fn(), pending = issuePlatformMcpKey(actor, "merchant-a", "integration-a", input, headers).then(value => { resolved(value); return value; });
    await vi.waitFor(() => expect(ports.database).toHaveBeenCalledTimes(2));
    expect(ports.readiness).toHaveBeenCalledWith("read"); expect(resolved).not.toHaveBeenCalled();
    finishCommit(); expect(await pending).toMatchObject({ revealedKey: "synthetic-local-only-key" });
  });
  it("does not expose a generated result after a COMMIT error", async () => {
    const pending = issuePlatformMcpKey(actor, "merchant-a", "integration-a", input, headers);
    const assertion = expect(pending).rejects.toThrow("synthetic commit failure");
    await vi.waitFor(() => expect(ports.database).toHaveBeenCalledTimes(2));
    failCommit(new Error("synthetic commit failure")); await assertion;
  });
  it("still enters receipt reconciliation after readiness fails", async () => {
    ports.readiness.mockRejectedValueOnce(new Error("synthetic missing owned file"));
    const pending = issuePlatformMcpKey(actor, "merchant-a", "integration-a", input, headers);
    await vi.waitFor(() => expect(ports.database).toHaveBeenCalledTimes(2)); finishCommit(); await pending;
  });
  it("derives rotation readiness from current key scopes, never from a client profile override", async () => {
    keyScopes = ["orders:write"];
    const pending = rotatePlatformMcpKey(actor, "merchant-a", "integration-a", "b".repeat(32), { ...input, expectedKeyVersion: 2, reason: "credential_rotation" }, headers);
    await vi.waitFor(() => expect(ports.database).toHaveBeenCalledTimes(2));
    expect(ports.readiness).toHaveBeenCalledWith("commerce"); finishCommit(); await pending;
  });
  it("bounds the whole preflight/probe/commit attempt to two admissions and releases capacity after failure", async () => {
    const releases: Array<(value: undefined) => void> = [];
    ports.database.mockImplementation(async (_write, work) => work({ query: ports.query }, "production"));
    ports.readiness.mockImplementation(() => new Promise<undefined>(resolve => releases.push(resolve)));
    const first = issuePlatformMcpKey(actor, "merchant-a", "integration-a", input, headers).catch(error => error);
    const second = issuePlatformMcpKey(actor, "merchant-a", "integration-a", input, headers).catch(error => error);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    await expect(issuePlatformMcpKey(actor, "merchant-a", "integration-a", input, headers)).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(ports.database).toHaveBeenCalledTimes(2);
    for (const release of releases) release(undefined);
    await Promise.all([first, second]);
    allowed = false;
    await expect(issuePlatformMcpKey(actor, "merchant-a", "integration-a", input, headers)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("rejects raw scopes or unbounded request identity before probing", async () => {
    await expect(issuePlatformMcpKey(actor, "merchant-a", "integration-a", { ...input, scopes: ["orders:write"] }, headers)).rejects.toMatchObject({ code: "validation_error" });
    expect(ports.database).not.toHaveBeenCalled();
    await expect(issuePlatformMcpKey(actor, "merchant-a", "integration-a", input, {})).rejects.toMatchObject({ code: "idempotency_key_required" });
    expect(ports.query).not.toHaveBeenCalled(); expect(ports.readiness).not.toHaveBeenCalled();
  });
});
