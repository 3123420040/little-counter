import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PermissionId } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";

const operationalWrites: PermissionId[] = [
  "catalog:write",
  "customer:write",
  "loyalty:write",
  "order:write",
  "inventory:write",
];
const allNewWrites: PermissionId[] = [...operationalWrites, "accounting:write"];
const orderExport: PermissionId = "orders:export";
const teamManagement: PermissionId[] = ["team:read", "team:write", "team:reset_password"];
const staffShift: PermissionId[] = ["shift:open", "shift:close", "shift:read", "shift:cash_adjust"];
const managerShift: PermissionId[] = [...staffShift, "shift:review", "shift:manage", "shift:report"];
const sensitivePlatform: PermissionId[] = [
  "platform_operator:reset_password",
  "platform_operator:suspend",
  "platform_membership:write",
  "platform_impersonation:start",
];

let client: PoolClient;

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
});

afterAll(async () => {
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("permission seed defaults", () => {
  it("seeds explicit write grants without giving accountant manager powers", async () => {
    const result = await client.query<{ role: "staff" | "manager" | "accountant" | "owner"; permission_id: PermissionId }>(`
      SELECT role, permission_id
      FROM app.role_permissions
      WHERE role IN ('staff', 'manager', 'accountant', 'owner')
      ORDER BY role, permission_id
    `);
    const grants = new Map<"staff" | "manager" | "accountant" | "owner", Set<PermissionId>>();
    for (const role of ["staff", "manager", "accountant", "owner"] as const) grants.set(role, new Set());
    for (const row of result.rows) grants.get(row.role)?.add(row.permission_id);

    for (const role of ["staff", "manager", "accountant", "owner"] as const) {
      expect(grants.get(role)).toContain("category:read");
      expect(grants.get(role)).toContain("customer:read");
      expect(grants.get(role)).toContain("customer:write");
    }
    expect(grants.get("staff")).not.toContain("catalog:write");
    expect(grants.get("staff")).not.toContain("accounting:write");
    expect([...grants.get("manager")!]).toEqual(expect.arrayContaining(operationalWrites));
    expect(grants.get("manager")).not.toContain("accounting:write");
    expect([...grants.get("owner")!]).toEqual(expect.arrayContaining(allNewWrites));
    expect(grants.get("accountant")).toContain("accounting:write");
    expect(grants.get("accountant")).toContain(orderExport);
    expect(grants.get("manager")).toContain(orderExport);
    expect(grants.get("owner")).toContain(orderExport);
    expect([...grants.get("manager")!]).toEqual(expect.arrayContaining(teamManagement));
    expect([...grants.get("owner")!]).toEqual(expect.arrayContaining(teamManagement));
    expect([...grants.get("manager")!]).toEqual(expect.arrayContaining(managerShift));
    expect([...grants.get("owner")!]).toEqual(expect.arrayContaining(managerShift));
    for (const permissionId of staffShift) {
      expect(grants.get("manager")).toContain(permissionId);
      expect(grants.get("owner")).toContain(permissionId);
    }
    const staffResult = await client.query<{ permission_id: PermissionId }>(`
      SELECT permission_id
      FROM app.role_permissions
      WHERE role = 'staff'
    `);
    const staffGrants = new Set(staffResult.rows.map((row) => row.permission_id));
    for (const permissionId of staffShift) {
      expect(staffGrants).toContain(permissionId);
    }
    expect(staffGrants).not.toContain("shift:review");
    expect(staffGrants).not.toContain("shift:manage");
    expect(staffGrants).not.toContain("shift:report");
    for (const permissionId of operationalWrites.filter((permissionId) => permissionId !== "customer:write")) {
      expect(grants.get("accountant")).not.toContain(permissionId);
    }
    for (const permissionId of managerShift) {
      expect(grants.get("accountant")).not.toContain(permissionId);
    }
    for (const permissionId of teamManagement) {
      expect(grants.get("accountant")).not.toContain(permissionId);
    }
    for (const permissionId of sensitivePlatform) {
      expect(grants.get("manager")).not.toContain(permissionId);
      expect(grants.get("owner")).not.toContain(permissionId);
      expect(grants.get("accountant")).not.toContain(permissionId);
    }
  });
});
