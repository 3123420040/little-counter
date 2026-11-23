import { describe, expect, it } from "vitest";
import {
  CursorClaimsV1Schema,
} from "@medusa-snus/contracts";
import {
  OrderCursorError,
  advanceOrderCursorV1,
  createOrderCursorV1,
  hashOrderCursorFiltersV1,
  hashStoreRevisionVectorV1,
  normalizeOrderCursorFiltersV1,
  verifyOrderCursorV1,
  type OrderCursorKeyringV1,
} from "../services/order-cursor-service";

const currentKey = Buffer.alloc(32, 7).toString("base64url");
const previousKey = Buffer.alloc(32, 3).toString("base64url");

const keyring: OrderCursorKeyringV1 = {
  current: { keyId: "cursor-current", keyBase64Url: currentKey },
  previous: { keyId: "cursor-previous", keyBase64Url: previousKey },
};

const scope = { merchantId: "merchant-a", storeIds: ["store-a", "store-b"] };
const filters = normalizeOrderCursorFiltersV1({
  search: "  ORD-2026   TEST  ",
  statusMode: "COMPLETED",
  storeWindows: [
    {
      storeId: "store-b",
      startInclusive: "2026-08-03T17:00:00.000Z",
      endExclusive: "2026-08-04T17:00:00.000Z",
    },
    {
      storeId: "store-a",
      startInclusive: "2026-08-04T00:00:00.000Z",
      endExclusive: "2026-08-05T00:00:00.000Z",
    },
  ],
});
const revisions = [
  { storeId: "store-a", revision: 17 },
  { storeId: "store-b", revision: 9 },
];

function issue(
  overrides: Partial<Parameters<typeof createOrderCursorV1>[0]> = {},
  selectedKeyring: OrderCursorKeyringV1 = keyring,
) {
  return createOrderCursorV1({
    nowEpochSeconds: 1_800_000_000,
    scope,
    filters,
    highWatermark: { createdAt: "2026-08-04T12:00:00.000Z", id: "order-z" },
    position: { createdAt: "2026-08-04T11:00:00.000Z", id: "order-m" },
    storeRevisionVector: revisions,
    asOf: "2026-08-04T12:00:01.000Z",
    ...overrides,
  }, selectedKeyring);
}

function verify(
  token: string,
  overrides: Partial<Parameters<typeof verifyOrderCursorV1>[1]> = {},
  selectedKeyring: OrderCursorKeyringV1 = keyring,
) {
  return verifyOrderCursorV1(token, {
    nowEpochSeconds: 1_800_000_100,
    scope,
    filters,
    storeRevisionVector: revisions,
    ...overrides,
  }, selectedKeyring);
}

function expectCursorError(action: () => unknown, code: string) {
  try {
    action();
    throw new Error("expected cursor error");
  } catch (error) {
    expect(error).toBeInstanceOf(OrderCursorError);
    expect(error).toMatchObject({ code, publicPayload: { code, refreshFromStart: true } });
    expect(JSON.stringify((error as OrderCursorError).publicPayload)).not.toContain("merchant-a");
  }
}

describe("PAGE-01A signed opaque order cursor", () => {
  it("normalizes immutable filters and hashes store revisions canonically", () => {
    expect(filters).toEqual({
      searchMode: "order_identity",
      search: "ord-2026 test",
      statusMode: "completed",
      storeWindows: [
        expect.objectContaining({ storeId: "store-a" }),
        expect.objectContaining({ storeId: "store-b" }),
      ],
    });
    expect(hashOrderCursorFiltersV1(filters)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashStoreRevisionVectorV1(revisions)).toBe(hashStoreRevisionVectorV1([
      revisions[1]!,
      revisions[0]!,
    ]));
    expect(() => normalizeOrderCursorFiltersV1({
      ...filters,
      storeWindows: [filters.storeWindows[0], filters.storeWindows[0]],
    })).toThrow();
  });

  it("encrypts tenant claims, verifies every binding and preserves the page position", () => {
    const token = issue();
    expect(token).not.toContain("merchant-a");
    expect(Buffer.from(token, "base64url").toString("utf8")).not.toContain("merchant-a");

    const claims = verify(token);
    expect(claims).toMatchObject({
      schemaVersion: 1,
      audience: "order_list_v2",
      keyId: "cursor-current",
      issuedAtEpochSeconds: 1_800_000_000,
      expiresAtEpochSeconds: 1_800_000_900,
      scope,
      position: { createdAt: "2026-08-04T11:00:00.000Z", id: "order-m" },
      highWatermark: { createdAt: "2026-08-04T12:00:00.000Z", id: "order-z" },
      asOf: "2026-08-04T12:00:01.000Z",
    });
    expect(CursorClaimsV1Schema.parse(claims)).toEqual(claims);
  });

  it("preserves the original expiry/high-water/asOf when advancing and rotates keys", () => {
    const original = verify(issue());
    const rotatedKeyring: OrderCursorKeyringV1 = {
      current: keyring.previous!,
      previous: keyring.current,
    };
    expect(verifyOrderCursorV1(issue(), {
      nowEpochSeconds: 1_800_000_200,
      scope,
      filters,
      storeRevisionVector: revisions,
    }, rotatedKeyring).keyId).toBe("cursor-current");
    const nextToken = advanceOrderCursorV1(original, {
      createdAt: "2026-08-04T10:00:00.000Z",
      id: "order-a",
    }, rotatedKeyring);
    const next = verifyOrderCursorV1(nextToken, {
      nowEpochSeconds: 1_800_000_200,
      scope,
      filters,
      storeRevisionVector: revisions,
    }, rotatedKeyring);

    expect(next.keyId).toBe("cursor-previous");
    expect(next.position.id).toBe("order-a");
    expect(next.issuedAtEpochSeconds).toBe(original.issuedAtEpochSeconds);
    expect(next.expiresAtEpochSeconds).toBe(original.expiresAtEpochSeconds);
    expect(next.highWatermark).toEqual(original.highWatermark);
    expect(next.asOf).toBe(original.asOf);
  });

  it("fails closed for tampering, unknown/weak keys, scope/filter and expiry", () => {
    const token = issue();
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    expectCursorError(() => verify(tampered), "invalid_cursor");
    expectCursorError(() => verify(token, {
      scope: { merchantId: "merchant-other", storeIds: ["store-a", "store-b"] },
    }), "invalid_cursor");
    expectCursorError(() => verify(token, {
      filters: normalizeOrderCursorFiltersV1({
        ...filters,
        search: "different-order",
      }),
    }), "invalid_cursor");
    expectCursorError(() => verify(token, { nowEpochSeconds: 1_800_000_901 }), "expired_cursor");
    expectCursorError(() => verify(token, {}, {
      current: { keyId: "unknown", keyBase64Url: Buffer.alloc(32, 9).toString("base64url") },
    }), "invalid_cursor");
    expect(() => issue({}, {
      current: { keyId: "weak", keyBase64Url: Buffer.alloc(16).toString("base64url") },
    })).toThrow();
    expect(() => issue({
      filters: normalizeOrderCursorFiltersV1({
        ...filters,
        storeWindows: [filters.storeWindows[0]],
      }),
    })).toThrow();
    expect(() => issue({
      storeRevisionVector: [{ storeId: "store-a", revision: 17 }],
    })).toThrow();
  });

  it("returns stale only after valid scope/filter authentication when revisions change", () => {
    const token = issue();
    expectCursorError(() => verify(token, {
      storeRevisionVector: [
        { storeId: "store-a", revision: 18 },
        { storeId: "store-b", revision: 9 },
      ],
    }), "stale_cursor");
  });

  it("rejects impossible high-water/last-position and future-issued claims", () => {
    expect(() => issue({
      position: { createdAt: "2026-08-04T13:00:00.000Z", id: "order-newer" },
    })).toThrow();
    expectCursorError(() => verify(issue(), { nowEpochSeconds: 1_799_999_999 }), "invalid_cursor");
  });
});
