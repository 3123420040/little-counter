import { describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import {
  createOriginalOrderCommercialRevisionTaskV1,
  type NormalizedOriginalOrderCommercialRevisionV1,
  type OriginalOrderCommercialRevisionInputV1,
} from "../services/original-order-commercial-revision-service";
import {
  PostgresOriginalOrderCommercialRevisionRepositoryV1,
} from "../services/postgres-original-order-commercial-revision-repository";

const revisionId = "00000000-0000-4000-8000-000000000101";
const lineId = "00000000-0000-4000-8000-000000000201";

const input: OriginalOrderCommercialRevisionInputV1 = {
  merchantId: "merchant-a",
  storeId: "store-a",
  orderId: "order-a",
  orderCreatedInCurrentTransaction: true,
  currencyCode: "VND",
  minorUnitExponent: 0,
  sourceOccurredAt: "2026-08-05T04:00:00.000Z",
  totals: {
    taxMode: "inclusive",
    vatRatePpm: 100_000,
    commercialCalculationVersion: 1,
    subtotalMinor: 110_000,
    discountMinor: 0,
    merchandisePayableMinor: 110_000,
    shippingMinor: 11_000,
    merchandiseVatMinor: 10_000,
    shippingVatMinor: 1_000,
    vatMinor: 11_000,
    unclassifiedMinor: 2_000,
    totalMinor: 123_000,
  },
  lines: [{
    lineKey: "line-a",
    sourceLineId: "source-a",
    productId: "product-a",
    variantId: "variant-a",
    skuSnapshot: "SKU-A",
    titleSnapshot: "Product A",
    archivedVariant: false,
    quantity: 1,
    unitPriceMinor: 110_000,
    unitCostMinor: 50_000,
    costEvidenceId: "catalog-cost:variant-a:2026-08-05T04:00:00.000Z",
  }],
};

function normalizedBundle(): NormalizedOriginalOrderCommercialRevisionV1 {
  let captured: NormalizedOriginalOrderCommercialRevisionV1 | undefined;
  const task = createOriginalOrderCommercialRevisionTaskV1({
    config: { enabled: true },
    repository: {
      appendOriginalRevision: async (bundle) => {
        captured = bundle;
        return {
          outcome: "inserted",
          bundleFingerprint: bundle.bundleFingerprint,
          merchantId: bundle.merchantId,
          storeId: bundle.storeId,
          orderId: bundle.orderId,
          revisionId,
          revision: 0,
          idempotencyKey: bundle.idempotencyKey,
        };
      },
    },
  }, input);
  if (!task.enabled) throw new Error("expected enabled task");
  void task.execute();
  if (!captured) throw new Error("bundle not captured");
  return captured;
}

function partialNormalizedBundle(): NormalizedOriginalOrderCommercialRevisionV1 {
  let captured: NormalizedOriginalOrderCommercialRevisionV1 | undefined;
  const task = createOriginalOrderCommercialRevisionTaskV1({
    config: { enabled: true },
    repository: {
      appendOriginalRevision: async (bundle) => {
        captured = bundle;
        return {
          outcome: "inserted",
          bundleFingerprint: bundle.bundleFingerprint,
          merchantId: bundle.merchantId,
          storeId: bundle.storeId,
          orderId: bundle.orderId,
          revisionId,
          revision: 0,
          idempotencyKey: bundle.idempotencyKey,
        };
      },
    },
  }, {
    ...input,
    lines: [{
      ...input.lines[0]!,
      unitCostMinor: null,
      costEvidenceId: null,
    }],
  } as unknown as OriginalOrderCommercialRevisionInputV1);
  if (!task.enabled) throw new Error("expected enabled task");
  void task.execute();
  if (!captured) throw new Error("bundle not captured");
  return captured;
}

function metadata(bundle: NormalizedOriginalOrderCommercialRevisionV1) {
  return {
    bundleVersion: 1,
    bundleFingerprint: bundle.bundleFingerprint,
    componentContract: "order-commercial-components.v1-tax-attributed",
    vatRatePpm: 100_000,
    commercialCalculationVersion: 1,
    roundingPolicy: "nearest_minor_half_toward_positive_infinity",
  };
}

function replayRow(bundle: NormalizedOriginalOrderCommercialRevisionV1) {
  return {
    revision_record: {
      id: revisionId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      order_id: bundle.orderId,
      revision: 0,
      source_type: "original_order",
      source_id: bundle.orderId,
      source_correction_id: null,
      commercial_state: "active",
      currency_code: "VND",
      minor_unit_exponent: 0,
      effective_at: bundle.sourceOccurredAt,
      idempotency_key: bundle.idempotencyKey,
      data_quality: bundle.dataQuality,
      metadata: metadata(bundle),
    },
    component_record: {
      revision_id: revisionId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      order_id: bundle.orderId,
      revision: 0,
      currency_code: "VND",
      minor_unit_exponent: 0,
      tax_mode: bundle.components.taxMode,
      merchandise_gross_minor: bundle.components.merchandiseGrossMinor,
      discount_minor: bundle.components.discountMinor,
      merchandise_net_minor: bundle.components.merchandiseNetMinor,
      shipping_minor: bundle.components.shippingMinor,
      merchandise_vat_minor: bundle.components.merchandiseVatMinor,
      shipping_vat_minor: bundle.components.shippingVatMinor,
      vat_minor: bundle.components.vatMinor,
      unclassified_minor: bundle.components.unclassifiedMinor,
      total_minor: bundle.components.totalMinor,
    },
    line_records: bundle.lines.map((line) => ({
      revision_id: revisionId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      order_id: bundle.orderId,
      revision: 0,
      line_key: line.lineKey,
      source_line_id: line.sourceLineId,
      product_id: line.productId,
      variant_id: line.variantId,
      sku_snapshot: line.skuSnapshot,
      title_snapshot: line.titleSnapshot,
      archived_variant: line.archivedVariant,
      quantity: line.quantity,
      unit_price_minor: line.unitPriceMinor,
      line_total_minor: line.lineTotalMinor,
      cost_minor: line.unitCostMinor,
      cost_evidence_id: line.costEvidenceId,
    })),
  };
}

class FakeClient {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  existing: ReturnType<typeof replayRow> | null = null;
  failMarker: string | null = null;

  async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (this.failMarker && sql.includes(this.failMarker)) {
      throw new Error(`forced failure at ${this.failMarker}`);
    }
    if (sql.includes("original_order_commercial_revision_existing")) {
      return { rows: this.existing ? [this.existing as T] : [] as T[] };
    }
    if (sql.includes("original_order_commercial_revision_insert_revision")) {
      return { rows: [{ id: revisionId }] as T[] };
    }
    if (sql.includes("original_order_commercial_revision_insert_components")) {
      return { rows: [{ id: revisionId }] as T[] };
    }
    if (sql.includes("original_order_commercial_revision_insert_line")) {
      return { rows: [{ id: lineId }] as T[] };
    }
    return { rows: [] as T[] };
  }
}

function repository(fake: FakeClient, ownership: "repository" | "caller" = "repository") {
  return new PostgresOriginalOrderCommercialRevisionRepositoryV1(
    fake as unknown as PoolClient,
    { statementTimeoutMs: 10_000, lockTimeoutMs: 1_000, transactionOwnership: ownership },
  );
}

describe("ORD-REV-01 fake PostgreSQL original-revision adapter", () => {
  it("writes revision, tax-attributed components and complete lines before commit", async () => {
    const fake = new FakeClient();
    const bundle = normalizedBundle();
    await expect(repository(fake).appendOriginalRevision(bundle)).resolves.toMatchObject({
      outcome: "inserted",
      revisionId,
      revision: 0,
    });
    const calls = fake.calls.map((call) => call.sql.trim());
    expect(calls[0]).toMatch(/^BEGIN/);
    expect(calls.at(-1)).toBe("COMMIT");
    expect(calls.findIndex((sql) => sql.includes("insert_revision"))).toBeLessThan(
      calls.findIndex((sql) => sql.includes("insert_components")),
    );
    expect(calls.findIndex((sql) => sql.includes("insert_components"))).toBeLessThan(
      calls.findIndex((sql) => sql.includes("insert_line")),
    );
    const componentCall = fake.calls.find((call) => call.sql.includes("insert_components"))!;
    expect(componentCall.params).toEqual([
      revisionId,
      "merchant-a",
      "store-a",
      "order-a",
      "inclusive",
      110_000,
      0,
      110_000,
      11_000,
      10_000,
      1_000,
      11_000,
      2_000,
      123_000,
    ]);
  });

  it("returns an exact replay without any insert", async () => {
    const fake = new FakeClient();
    const bundle = normalizedBundle();
    fake.existing = replayRow(bundle);
    await expect(repository(fake).appendOriginalRevision(bundle)).resolves.toMatchObject({
      outcome: "replayed",
      revisionId,
    });
    expect(fake.calls.some((call) => call.sql.includes("insert_"))).toBe(false);
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("persists and replays paired-null historical cost with partial revision quality", async () => {
    const fake = new FakeClient();
    const bundle = partialNormalizedBundle();
    expect(bundle.dataQuality).toBe("partial");
    await expect(repository(fake).appendOriginalRevision(bundle)).resolves.toMatchObject({
      outcome: "inserted",
      revisionId,
    });
    const revisionInsert = fake.calls.find((call) => call.sql.includes("insert_revision"))!;
    const lineInsert = fake.calls.find((call) => call.sql.includes("insert_line"))!;
    expect(revisionInsert.params?.[5]).toBe("partial");
    expect(lineInsert.params?.slice(-2)).toEqual([null, null]);

    const replaying = new FakeClient();
    replaying.existing = replayRow(bundle);
    await expect(repository(replaying).appendOriginalRevision(bundle)).resolves.toMatchObject({
      outcome: "replayed",
      revisionId,
    });
    expect(replaying.calls.some((call) => call.sql.includes("insert_"))).toBe(false);
  });

  it("uses the caller transaction without local begin, commit or rollback", async () => {
    const fake = new FakeClient();
    await repository(fake, "caller").appendOriginalRevision(normalizedBundle());
    expect(fake.calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql))).toBe(false);

    const failing = new FakeClient();
    failing.failMarker = "insert_components";
    await expect(
      repository(failing, "caller").appendOriginalRevision(normalizedBundle()),
    ).rejects.toThrow("forced failure");
    expect(failing.calls.some((call) => call.sql === "ROLLBACK")).toBe(false);
  });

  it("rolls back an owned transaction on every persistence failure", async () => {
    for (const marker of ["insert_revision", "insert_components", "insert_line"]) {
      const fake = new FakeClient();
      fake.failMarker = marker;
      await expect(repository(fake).appendOriginalRevision(normalizedBundle())).rejects.toThrow(
        "forced failure",
      );
      expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
      expect(fake.calls.some((call) => call.sql === "COMMIT")).toBe(false);
    }
  });

  it("rejects replay drift and forged normalized fingerprints", async () => {
    const bundle = normalizedBundle();
    const drift = new FakeClient();
    drift.existing = replayRow(bundle);
    (drift.existing.component_record as Record<string, unknown>).vat_minor = 10_999;
    await expect(repository(drift).appendOriginalRevision(bundle)).rejects.toThrow("drift");
    expect(drift.calls.at(-1)?.sql).toBe("ROLLBACK");

    const forged = new FakeClient();
    await expect(repository(forged).appendOriginalRevision({
      ...bundle,
      bundleFingerprint: "f".repeat(64),
    })).rejects.toThrow("identity drift");
    expect(forged.calls).toHaveLength(0);
  });
});
