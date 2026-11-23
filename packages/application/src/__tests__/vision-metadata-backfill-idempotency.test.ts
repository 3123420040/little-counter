import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(__dirname, "../../../..");
const schemaSource = readFileSync(
  resolve(repositoryRoot, "packages/application/src/db/schema.ts"),
  "utf8",
);

describe("vision metadata-image compatibility backfill", () => {
  it("does not manufacture a second primary when a curated primary already exists", () => {
    const backfillStart = schemaSource.indexOf("$vision_backfill$");
    const backfillEnd = schemaSource.indexOf(
      "$vision_backfill$;",
      backfillStart + 1,
    );
    const backfill = schemaSource.slice(backfillStart, backfillEnd);

    expect(backfill).toContain("existing.store_id IS NOT DISTINCT FROM s.id");
    expect(backfill).toContain("existing.variant_id = v.id");
    expect(backfill).toContain("existing.image_url = p.metadata->>'imageUrl'");
    expect(backfill).toContain("OR existing.is_primary = true");
  });
});
