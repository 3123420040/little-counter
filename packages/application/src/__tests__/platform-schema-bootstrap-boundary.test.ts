import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePlatformSchema, shouldRunPlatformSchemaBootstrap } from "../db/schema";
import { connectPlatformClient } from "../db/client";

vi.mock("../db/client", () => ({ connectPlatformClient: vi.fn() }));
afterEach(() => vi.unstubAllEnvs());

describe("platform runtime schema bootstrap", () => {
  it.each([undefined, "true", "false"])("does not connect or seed during production adoption (%s)", async flag => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED", flag);
    expect(shouldRunPlatformSchemaBootstrap()).toBe(false);
    await ensurePlatformSchema();
    expect(connectPlatformClient).not.toHaveBeenCalled();
  });

  it("requires an explicit opt-in outside the test environment", () => {
    expect(shouldRunPlatformSchemaBootstrap({})).toBe(false);
    expect(shouldRunPlatformSchemaBootstrap({ NODE_ENV: "development" })).toBe(false);
    expect(shouldRunPlatformSchemaBootstrap({ NODE_ENV: "development", PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED: "true" })).toBe(true);
    expect(shouldRunPlatformSchemaBootstrap({ NODE_ENV: "test" })).toBe(true);
    expect(shouldRunPlatformSchemaBootstrap({ NODE_ENV: "test", PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED: "false" })).toBe(false);
  });
});
