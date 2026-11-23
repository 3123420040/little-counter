import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("release dependency security floor", () => {
  it("pins compatible patched Browserslist and fast-uri in both manifest and lockfile", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    for (const [name, version] of [["browserslist", "4.28.9"], ["fast-uri", "3.1.7"]]) {
      expect(manifest.overrides[name]).toBe(version);
      const installed = Object.entries(lock.packages)
        .filter(([entry]) => entry === `node_modules/${name}` || entry.endsWith(`/node_modules/${name}`));
      expect(installed.length).toBeGreaterThan(0);
      for (const [, entry] of installed) {
        expect((entry as { version: string }).version).toBe(version);
      }
    }
  });
});
