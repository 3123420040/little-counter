import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeCapabilityTokensV1 } from "@medusa-snus/contracts/runtime-capabilities";
import { runtimeCapabilityRouteManifestV1 } from "../services/runtime-capability-route-manifest";

describe("C2 compiled runtime route readiness", () => {
  it("maps every public capability token to a physical route implementation", () => {
    expect(Object.keys(runtimeCapabilityRouteManifestV1).sort()).toEqual(
      [...runtimeCapabilityTokensV1].sort(),
    );
    for (const routePath of Object.values(runtimeCapabilityRouteManifestV1)) {
      expect(existsSync(resolve(process.cwd(), routePath)), routePath).toBe(true);
    }
  });
});
