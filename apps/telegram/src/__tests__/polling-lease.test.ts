import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { acquirePollingLease, renewPollingLease } from "../index";

let tempDir = "";

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("Telegram local polling lease", () => {
  it("prevents duplicate pollers while allowing the same holder to renew", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "telegram-lease-"));
    const leaseFile = join(tempDir, "lease.json");

    const first = await acquirePollingLease(leaseFile, 90, "holder-a");
    expect(first.holderId).toBe("holder-a");

    await expect(acquirePollingLease(leaseFile, 90, "holder-b")).rejects.toThrow(/already held by holder-a/);

    const renewed = await renewPollingLease(leaseFile, 90, "holder-a");
    expect(renewed.holderId).toBe("holder-a");
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now());
  });
});
