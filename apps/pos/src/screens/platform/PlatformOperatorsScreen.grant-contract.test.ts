import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./PlatformOperatorsScreen.tsx", import.meta.url), "utf8");

describe("PlatformOperatorsScreen explicit grant freshness contract", () => {
  it("stores selection by id and derives the current operator from query data", () => {
    expect(source).toContain("const [selectedOperatorId, setSelectedOperatorId]");
    expect(source).toContain("rows.find((operator) => operator.operatorId === selectedOperatorId)");
    expect(source).not.toContain("const [selectedOperator, setSelectedOperator]");
  });

  it("only counts and renders currently effective grants", () => {
    expect(source).toContain("operator.explicitGrants.filter((grant) => isEffectivePlatformOperatorGrant(grant))");
    expect(source).toContain("(selectedOperator?.explicitGrants || []).filter((grant) => isEffectivePlatformOperatorGrant(grant))");
  });
});
