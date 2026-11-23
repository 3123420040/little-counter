import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "../db/client";
import { lockPlatformAdminCommandAuthority } from "../services/platform-business-lifecycle-service";
import type { PermissionActor } from "../services/permission-service";

describe("dedicated platform lifecycle command authority", () => {
  it("rejects a read-only member despite forged cached admin access and a generic write grant", async () => {
    const actor = {
      operatorId: "reader", authState: "authenticated", sessionVersion: 1,
      sessionExpiresAt: "2099-01-01T00:00:00.000Z", role: "owner", isPlatformAdmin: true,
      access: { isPlatformAdmin: true, permissionIds: ["platform:write"], memberships: [{
        scopeType: "platform", platformRoleKey: "platform_admin", status: "active",
      }] },
    } as unknown as PermissionActor;
    const query = vi.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ is_active: true }] })
      .mockResolvedValueOnce({ rows: [{ global_status: "active", session_version: 1, requires_password_change: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ valid: false }] });
    await expect(lockPlatformAdminCommandAuthority({ query } as unknown as PoolClient, actor))
      .rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
    expect(query.mock.calls[3][0]).toContain("role_key='platform_admin'");
    expect(query.mock.calls[4][1][0]).toEqual([]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("operator_explicit_permission_grants"))).toBe(false);
  });
});
