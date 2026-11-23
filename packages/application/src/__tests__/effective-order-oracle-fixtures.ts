/**
 * TEST-01 oracle only. This file deliberately imports no production service,
 * repository, schema helper, or total calculator.
 */

export type OracleLine = {
  sku: string;
  quantity: number;
  unitPriceMinor: number;
  archived?: boolean;
};

export type CommercialSnapshot = {
  lines: OracleLine[];
  taxMode?: "inclusive" | "exclusive";
  discountMinor: number;
  shippingMinor: number;
  merchandiseVatMinor?: number;
  shippingVatMinor?: number;
  vatMinor: number;
  unclassifiedMinor: number;
  totalMinor: number;
};

export type OracleRevision = {
  id: string;
  revision: number;
  status: "applied" | "pending_settlement" | "cancelled";
  effectiveAt: string;
  snapshot: CommercialSnapshot;
};

export type EffectiveOrderOracleInput = {
  orderId: string;
  currencyCode: "VND";
  original: CommercialSnapshot;
  revisions: OracleRevision[];
  cancelledAt?: string;
};

export type EffectiveOrderOracleResult = {
  orderId: string;
  currencyCode: "VND";
  effectiveRevision: number;
  commercialState: "active" | "cancelled";
  lines: OracleLine[];
  components: {
    taxMode: "inclusive" | "exclusive";
    merchandiseGrossMinor: number;
    discountMinor: number;
    merchandiseNetMinor: number;
    shippingMinor: number;
    merchandiseVatMinor: number;
    shippingVatMinor: number;
    vatMinor: number;
    unclassifiedMinor: number;
    totalMinor: number;
  };
  currentOrderGrossValueMinor: number;
  dataQuality: {
    status: "complete";
    archivedVariantCount: number;
  };
};

type EffectiveOrderFixture = {
  name: string;
  input: EffectiveOrderOracleInput;
  expected: EffectiveOrderOracleResult;
};

function exactNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must use non-negative integer minor units`);
  }
  return value;
}

function projectSnapshot(
  order: EffectiveOrderOracleInput,
  snapshot: CommercialSnapshot,
  effectiveRevision: number,
): EffectiveOrderOracleResult {
  const merchandiseGrossMinor = snapshot.lines.reduce((sum, line, index) => {
    const quantity = exactNonnegativeInteger(line.quantity, `line[${index}].quantity`);
    const unitPriceMinor = exactNonnegativeInteger(
      line.unitPriceMinor,
      `line[${index}].unitPriceMinor`,
    );
    return sum + quantity * unitPriceMinor;
  }, 0);
  const discountMinor = exactNonnegativeInteger(snapshot.discountMinor, "discountMinor");
  const shippingMinor = exactNonnegativeInteger(snapshot.shippingMinor, "shippingMinor");
  const taxMode = snapshot.taxMode ?? "exclusive";
  const vatMinor = exactNonnegativeInteger(snapshot.vatMinor, "vatMinor");
  const merchandiseVatMinor = exactNonnegativeInteger(
    snapshot.merchandiseVatMinor ?? vatMinor,
    "merchandiseVatMinor",
  );
  const shippingVatMinor = exactNonnegativeInteger(
    snapshot.shippingVatMinor ?? 0,
    "shippingVatMinor",
  );
  const unclassifiedMinor = exactNonnegativeInteger(
    snapshot.unclassifiedMinor,
    "unclassifiedMinor",
  );
  const totalMinor = exactNonnegativeInteger(snapshot.totalMinor, "totalMinor");
  if (discountMinor > merchandiseGrossMinor) {
    throw new Error("discount exceeds merchandise gross");
  }
  const merchandiseNetMinor = merchandiseGrossMinor - discountMinor;
  if (merchandiseVatMinor + shippingVatMinor !== vatMinor) {
    throw new Error("snapshot VAT attribution does not equal vatMinor");
  }
  if (
    merchandiseNetMinor
      + shippingMinor
      + unclassifiedMinor
      + (taxMode === "exclusive" ? vatMinor : 0)
    !== totalMinor
  ) {
    throw new Error("snapshot component arithmetic does not equal totalMinor");
  }
  const cancelled = Boolean(order.cancelledAt);
  return {
    orderId: order.orderId,
    currencyCode: order.currencyCode,
    effectiveRevision,
    commercialState: cancelled ? "cancelled" : "active",
    lines: snapshot.lines.map((line) => ({ ...line })),
    components: {
      taxMode,
      merchandiseGrossMinor,
      discountMinor,
      merchandiseNetMinor,
      shippingMinor,
      merchandiseVatMinor,
      shippingVatMinor,
      vatMinor,
      unclassifiedMinor,
      totalMinor,
    },
    currentOrderGrossValueMinor: cancelled ? 0 : totalMinor,
    dataQuality: {
      status: "complete",
      archivedVariantCount: snapshot.lines.filter((line) => line.archived).length,
    },
  };
}

export function projectEffectiveOrder(
  order: EffectiveOrderOracleInput,
): EffectiveOrderOracleResult {
  const latest = order.revisions
    .filter((revision) => revision.status === "applied")
    .sort((left, right) => (
      right.revision - left.revision
      || right.effectiveAt.localeCompare(left.effectiveAt)
      || right.id.localeCompare(left.id)
    ))[0];
  return projectSnapshot(
    order,
    latest?.snapshot || order.original,
    latest?.revision || 0,
  );
}

export function originalFallbackProjection(
  order: EffectiveOrderOracleInput,
): EffectiveOrderOracleResult {
  return projectSnapshot(order, order.original, 0);
}

export const EFFECTIVE_ORDER_FIXTURES: EffectiveOrderFixture[] = [
  {
    name: "untouched order",
    input: {
      orderId: "ord-untouched",
      currencyCode: "VND",
      original: {
        lines: [{ sku: "A", quantity: 1, unitPriceMinor: 1_000 }],
        discountMinor: 0,
        shippingMinor: 100,
        vatMinor: 110,
        unclassifiedMinor: 0,
        totalMinor: 1_210,
      },
      revisions: [],
    },
    expected: {
      orderId: "ord-untouched",
      currencyCode: "VND",
      effectiveRevision: 0,
      commercialState: "active",
      lines: [{ sku: "A", quantity: 1, unitPriceMinor: 1_000 }],
      components: {
        taxMode: "exclusive",
        merchandiseGrossMinor: 1_000,
        discountMinor: 0,
        merchandiseNetMinor: 1_000,
        shippingMinor: 100,
        merchandiseVatMinor: 110,
        shippingVatMinor: 0,
        vatMinor: 110,
        unclassifiedMinor: 0,
        totalMinor: 1_210,
      },
      currentOrderGrossValueMinor: 1_210,
      dataQuality: { status: "complete", archivedVariantCount: 0 },
    },
  },
  {
    name: "add sku",
    input: {
      orderId: "ord-add",
      currencyCode: "VND",
      original: {
        lines: [{ sku: "A", quantity: 1, unitPriceMinor: 1_000 }],
        discountMinor: 0,
        shippingMinor: 0,
        vatMinor: 100,
        unclassifiedMinor: 0,
        totalMinor: 1_100,
      },
      revisions: [{
        id: "rev-add-1",
        revision: 1,
        status: "applied",
        effectiveAt: "2026-08-04T08:00:00.000Z",
        snapshot: {
          lines: [
            { sku: "A", quantity: 1, unitPriceMinor: 1_000 },
            { sku: "B", quantity: 2, unitPriceMinor: 300 },
          ],
          discountMinor: 100,
          shippingMinor: 100,
          vatMinor: 160,
          unclassifiedMinor: 0,
          totalMinor: 1_760,
        },
      }],
    },
    expected: {
      orderId: "ord-add",
      currencyCode: "VND",
      effectiveRevision: 1,
      commercialState: "active",
      lines: [
        { sku: "A", quantity: 1, unitPriceMinor: 1_000 },
        { sku: "B", quantity: 2, unitPriceMinor: 300 },
      ],
      components: {
        taxMode: "exclusive",
        merchandiseGrossMinor: 1_600,
        discountMinor: 100,
        merchandiseNetMinor: 1_500,
        shippingMinor: 100,
        merchandiseVatMinor: 160,
        shippingVatMinor: 0,
        vatMinor: 160,
        unclassifiedMinor: 0,
        totalMinor: 1_760,
      },
      currentOrderGrossValueMinor: 1_760,
      dataQuality: { status: "complete", archivedVariantCount: 0 },
    },
  },
  {
    name: "remove and replace sku",
    input: {
      orderId: "ord-replace",
      currencyCode: "VND",
      original: {
        lines: [
          { sku: "A", quantity: 1, unitPriceMinor: 1_000 },
          { sku: "B", quantity: 1, unitPriceMinor: 500 },
        ],
        discountMinor: 0,
        shippingMinor: 0,
        vatMinor: 150,
        unclassifiedMinor: 0,
        totalMinor: 1_650,
      },
      revisions: [{
        id: "rev-replace-1",
        revision: 1,
        status: "applied",
        effectiveAt: "2026-08-04T08:10:00.000Z",
        snapshot: {
          lines: [{ sku: "C", quantity: 1, unitPriceMinor: 800 }],
          discountMinor: 0,
          shippingMinor: 50,
          vatMinor: 85,
          unclassifiedMinor: 0,
          totalMinor: 935,
        },
      }],
    },
    expected: {
      orderId: "ord-replace",
      currencyCode: "VND",
      effectiveRevision: 1,
      commercialState: "active",
      lines: [{ sku: "C", quantity: 1, unitPriceMinor: 800 }],
      components: {
        taxMode: "exclusive",
        merchandiseGrossMinor: 800,
        discountMinor: 0,
        merchandiseNetMinor: 800,
        shippingMinor: 50,
        merchandiseVatMinor: 85,
        shippingVatMinor: 0,
        vatMinor: 85,
        unclassifiedMinor: 0,
        totalMinor: 935,
      },
      currentOrderGrossValueMinor: 935,
      dataQuality: { status: "complete", archivedVariantCount: 0 },
    },
  },
  {
    name: "multiple revisions",
    input: {
      orderId: "ord-multiple",
      currencyCode: "VND",
      original: {
        lines: [{ sku: "A", quantity: 1, unitPriceMinor: 1_000 }],
        discountMinor: 0,
        shippingMinor: 0,
        vatMinor: 100,
        unclassifiedMinor: 0,
        totalMinor: 1_100,
      },
      revisions: [
        {
          id: "rev-multiple-1",
          revision: 1,
          status: "applied",
          effectiveAt: "2026-08-04T08:20:00.000Z",
          snapshot: {
            lines: [{ sku: "A", quantity: 3, unitPriceMinor: 1_000 }],
            discountMinor: 0,
            shippingMinor: 0,
            vatMinor: 300,
            unclassifiedMinor: 0,
            totalMinor: 3_300,
          },
        },
        {
          id: "rev-multiple-2",
          revision: 2,
          status: "applied",
          effectiveAt: "2026-08-04T08:30:00.000Z",
          snapshot: {
            lines: [{ sku: "A", quantity: 2, unitPriceMinor: 1_000 }],
            discountMinor: 100,
            shippingMinor: 50,
            vatMinor: 195,
            unclassifiedMinor: 0,
            totalMinor: 2_145,
          },
        },
      ],
    },
    expected: {
      orderId: "ord-multiple",
      currencyCode: "VND",
      effectiveRevision: 2,
      commercialState: "active",
      lines: [{ sku: "A", quantity: 2, unitPriceMinor: 1_000 }],
      components: {
        taxMode: "exclusive",
        merchandiseGrossMinor: 2_000,
        discountMinor: 100,
        merchandiseNetMinor: 1_900,
        shippingMinor: 50,
        merchandiseVatMinor: 195,
        shippingVatMinor: 0,
        vatMinor: 195,
        unclassifiedMinor: 0,
        totalMinor: 2_145,
      },
      currentOrderGrossValueMinor: 2_145,
      dataQuality: { status: "complete", archivedVariantCount: 0 },
    },
  },
  {
    name: "discount shipping vat and unclassified fee",
    input: {
      orderId: "ord-components",
      currencyCode: "VND",
      original: {
        lines: [{ sku: "A", quantity: 2, unitPriceMinor: 1_000 }],
        discountMinor: 200,
        shippingMinor: 100,
        vatMinor: 190,
        unclassifiedMinor: 50,
        totalMinor: 2_140,
      },
      revisions: [],
    },
    expected: {
      orderId: "ord-components",
      currencyCode: "VND",
      effectiveRevision: 0,
      commercialState: "active",
      lines: [{ sku: "A", quantity: 2, unitPriceMinor: 1_000 }],
      components: {
        taxMode: "exclusive",
        merchandiseGrossMinor: 2_000,
        discountMinor: 200,
        merchandiseNetMinor: 1_800,
        shippingMinor: 100,
        merchandiseVatMinor: 190,
        shippingVatMinor: 0,
        vatMinor: 190,
        unclassifiedMinor: 50,
        totalMinor: 2_140,
      },
      currentOrderGrossValueMinor: 2_140,
      dataQuality: { status: "complete", archivedVariantCount: 0 },
    },
  },
  {
    name: "zero delta correction",
    input: {
      orderId: "ord-zero-delta",
      currencyCode: "VND",
      original: {
        lines: [{ sku: "A", quantity: 1, unitPriceMinor: 1_000 }],
        discountMinor: 0,
        shippingMinor: 0,
        vatMinor: 100,
        unclassifiedMinor: 0,
        totalMinor: 1_100,
      },
      revisions: [{
        id: "rev-zero-1",
        revision: 1,
        status: "applied",
        effectiveAt: "2026-08-04T09:00:00.000Z",
        snapshot: {
          lines: [{ sku: "A", quantity: 1, unitPriceMinor: 1_000 }],
          discountMinor: 0,
          shippingMinor: 0,
          vatMinor: 100,
          unclassifiedMinor: 0,
          totalMinor: 1_100,
        },
      }],
    },
    expected: {
      orderId: "ord-zero-delta",
      currencyCode: "VND",
      effectiveRevision: 1,
      commercialState: "active",
      lines: [{ sku: "A", quantity: 1, unitPriceMinor: 1_000 }],
      components: {
        taxMode: "exclusive",
        merchandiseGrossMinor: 1_000,
        discountMinor: 0,
        merchandiseNetMinor: 1_000,
        shippingMinor: 0,
        merchandiseVatMinor: 100,
        shippingVatMinor: 0,
        vatMinor: 100,
        unclassifiedMinor: 0,
        totalMinor: 1_100,
      },
      currentOrderGrossValueMinor: 1_100,
      dataQuality: { status: "complete", archivedVariantCount: 0 },
    },
  },
  {
    name: "archived variant snapshot",
    input: {
      orderId: "ord-archived",
      currencyCode: "VND",
      original: {
        lines: [{ sku: "OLD", quantity: 1, unitPriceMinor: 400 }],
        discountMinor: 0,
        shippingMinor: 0,
        vatMinor: 40,
        unclassifiedMinor: 0,
        totalMinor: 440,
      },
      revisions: [{
        id: "rev-archived-1",
        revision: 1,
        status: "applied",
        effectiveAt: "2026-08-04T09:10:00.000Z",
        snapshot: {
          lines: [{ sku: "OLD", quantity: 2, unitPriceMinor: 400, archived: true }],
          discountMinor: 0,
          shippingMinor: 0,
          vatMinor: 80,
          unclassifiedMinor: 0,
          totalMinor: 880,
        },
      }],
    },
    expected: {
      orderId: "ord-archived",
      currencyCode: "VND",
      effectiveRevision: 1,
      commercialState: "active",
      lines: [{ sku: "OLD", quantity: 2, unitPriceMinor: 400, archived: true }],
      components: {
        taxMode: "exclusive",
        merchandiseGrossMinor: 800,
        discountMinor: 0,
        merchandiseNetMinor: 800,
        shippingMinor: 0,
        merchandiseVatMinor: 80,
        shippingVatMinor: 0,
        vatMinor: 80,
        unclassifiedMinor: 0,
        totalMinor: 880,
      },
      currentOrderGrossValueMinor: 880,
      dataQuality: { status: "complete", archivedVariantCount: 1 },
    },
  },
  {
    name: "corrected then cancelled",
    input: {
      orderId: "ord-cancelled",
      currencyCode: "VND",
      original: {
        lines: [{ sku: "A", quantity: 1, unitPriceMinor: 1_000 }],
        discountMinor: 0,
        shippingMinor: 0,
        vatMinor: 100,
        unclassifiedMinor: 0,
        totalMinor: 1_100,
      },
      revisions: [{
        id: "rev-cancelled-1",
        revision: 1,
        status: "applied",
        effectiveAt: "2026-08-04T09:20:00.000Z",
        snapshot: {
          lines: [{ sku: "A", quantity: 2, unitPriceMinor: 1_000 }],
          discountMinor: 0,
          shippingMinor: 0,
          vatMinor: 200,
          unclassifiedMinor: 0,
          totalMinor: 2_200,
        },
      }],
      cancelledAt: "2026-08-04T09:30:00.000Z",
    },
    expected: {
      orderId: "ord-cancelled",
      currencyCode: "VND",
      effectiveRevision: 1,
      commercialState: "cancelled",
      lines: [{ sku: "A", quantity: 2, unitPriceMinor: 1_000 }],
      components: {
        taxMode: "exclusive",
        merchandiseGrossMinor: 2_000,
        discountMinor: 0,
        merchandiseNetMinor: 2_000,
        shippingMinor: 0,
        merchandiseVatMinor: 200,
        shippingVatMinor: 0,
        vatMinor: 200,
        unclassifiedMinor: 0,
        totalMinor: 2_200,
      },
      currentOrderGrossValueMinor: 0,
      dataQuality: { status: "complete", archivedVariantCount: 0 },
    },
  },
];

export const changedFixtureNames = [
  "add sku",
  "remove and replace sku",
  "multiple revisions",
  "zero delta correction",
  "archived variant snapshot",
  "corrected then cancelled",
] as const;
