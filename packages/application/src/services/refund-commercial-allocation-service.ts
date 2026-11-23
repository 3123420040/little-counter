import { createHash } from "node:crypto";
import {
  OrderCommercialComponentsV1Schema,
  OrderCommercialComponentsV2Schema,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import {
  freezeRefundAllocationV2,
  readFrozenRefundAllocationV2,
  refundComponentKeysV2,
  splitRefundComponentsV2,
  zeroRefundComponentsV2,
  type FrozenRefundAllocationV2,
} from "./refund-component-allocation";

function invariant(): never {
  throw new PlatformError(
    "financial_invariant_error",
    "Frozen refund accounting lineage is unavailable or inconsistent",
    409,
  );
}
function safeMinor(value: unknown): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) invariant();
  return amount;
}
function version(row: Record<string, unknown>): 1 | 2 {
  const record = row.component_record;
  if (!record || typeof record !== "object" || Array.isArray(record)) invariant();
  const fields = record as Record<string, unknown>;
  const value = fields.component_version === undefined ? 1 : Number(fields.component_version);
  if ((value !== 1 && value !== 2) || (value === 1 && (safeMinor(fields.payment_fee_minor ?? 0) !== 0 || safeMinor(fields.payment_fee_vat_minor ?? 0) !== 0))) invariant();
  return value;
}
export function readRefundCommercialBasisV2(row: Record<string, unknown>) {
  const record = row.component_record as Record<string, unknown>;
  if (!record) invariant();
  const componentVersion = version(row);
  const input = {
    taxMode: record.tax_mode,
    merchandiseGrossMinor: safeMinor(record.merchandise_gross_minor),
    discountMinor: safeMinor(record.discount_minor),
    merchandiseNetMinor: safeMinor(record.merchandise_net_minor),
    shippingMinor: safeMinor(record.shipping_minor),
    merchandiseVatMinor: safeMinor(record.merchandise_vat_minor),
    shippingVatMinor: safeMinor(record.shipping_vat_minor),
    vatMinor: safeMinor(record.vat_minor),
    unclassifiedMinor: safeMinor(record.unclassified_minor),
    totalMinor: safeMinor(record.total_minor),
    ...(componentVersion === 2
      ? {
          paymentFeeMinor: safeMinor(record.payment_fee_minor),
          paymentFeeVatMinor: safeMinor(record.payment_fee_vat_minor),
        }
      : {}),
  };
  const components =
    componentVersion === 2
      ? OrderCommercialComponentsV2Schema.parse(input)
      : OrderCommercialComponentsV1Schema.parse(input);
  const fee =
    componentVersion === 2
      ? OrderCommercialComponentsV2Schema.parse(components)
      : undefined;
  const capacities = {
    merchandiseRevenueMinor:
      components.merchandiseNetMinor -
      (components.taxMode === "inclusive" ? components.merchandiseVatMinor : 0),
    shippingRevenueMinor:
      components.shippingMinor -
      (components.taxMode === "inclusive" ? components.shippingVatMinor : 0),
    paymentFeeRevenueMinor: fee
      ? fee.paymentFeeMinor -
        (components.taxMode === "inclusive" ? fee.paymentFeeVatMinor : 0)
      : 0,
    vatMinor: components.vatMinor,
  };
  const commercialRevisionId = String(row.commercial_revision_id);
  const basisFingerprint = createHash("sha256")
    .update(
      JSON.stringify({ commercialRevisionId, componentVersion, components }),
    )
    .digest("hex");
  return {
    componentVersion,
    unclassifiedMinor: components.unclassifiedMinor,
    commercialRevisionId,
    basisFingerprint,
    capacities,
  };
}

export const REFUND_REVERSAL_EVIDENCE_SELECT_V2 = `
    SELECT events.id::text, events.kind, events.amount_minor, events.metadata,
      EXISTS (
        SELECT 1 FROM app.customer_refund_payout_allocations allocations
        JOIN app.customer_refund_payables payables ON payables.id = allocations.payable_id
        WHERE allocations.payment_event_id = events.id AND payables.payable_kind = 'manual_refund'
      ) AS legacy_reversal,
      COALESCE((SELECT SUM(allocations.amount_minor) FROM app.customer_refund_payout_allocations allocations
        JOIN app.customer_refund_payables payables ON payables.id = allocations.payable_id
        WHERE allocations.payment_event_id = events.id AND payables.payable_kind <> 'manual_refund'),0)::text AS legacy_settlement_minor
    FROM app.payment_events events
`;

export async function readPriorRefundReversalsForClientV2(
  client: Pick<PoolClient, "query">,
  scope: { merchantId: string; storeId: string; orderId: string },
) {
  const previous = await client.query<Record<string, unknown>>(
    `
    ${REFUND_REVERSAL_EVIDENCE_SELECT_V2}
    WHERE events.merchant_id = $1 AND events.store_id = $2 AND events.order_id = $3
      AND events.kind IN ('refund', 'reversal', 'chargeback') AND events.status = 'posted'
    ORDER BY events.recorded_at, events.id
  `,
    [scope.merchantId, scope.storeId, scope.orderId],
  );
  return sumPriorRefundReversalsV2(previous.rows);
}

export function sumPriorRefundReversalsV2(rows: readonly Record<string, unknown>[]) {
  const reversed = zeroRefundComponentsV2();
  for (const event of rows) {
    const raw = (event.metadata as Record<string, unknown>)?.refundAllocationV2;
    if (!raw) {
      if (
        event.kind !== "refund" ||
        event.legacy_reversal ||
        safeMinor(event.legacy_settlement_minor) !==
          safeMinor(event.amount_minor)
      )
        invariant();
      continue;
    }
    const allocation = readFrozenRefundAllocationV2(raw);
    if (allocation.amountMinor !== safeMinor(event.amount_minor)) invariant();
    for (const key of refundComponentKeysV2)
      reversed[key] = safeMinor(
        reversed[key] + allocation.reversalComponents[key],
      );
  }
  return reversed;
}

/** Caller holds the order row, then the customer-refund and obligation locks. */
export async function freezeRefundAccountingForClientV2(
  client: Pick<PoolClient, "query">,
  scope: { merchantId: string; storeId: string; orderId: string },
  amountMinor: number,
  currentComponentVersion: number,
  payableRows: Record<string, unknown>[],
  obligationRows: Record<string, unknown>[],
): Promise<FrozenRefundAllocationV2 | undefined> {
  let remaining = amountMinor;
  const selected = payableRows.flatMap((row) => {
    const allocated = Math.min(remaining, safeMinor(row.balance_minor));
    remaining -= allocated;
    return allocated ? [{ row, amountMinor: allocated }] : [];
  });
  if (remaining !== 0) invariant();
  if (
    currentComponentVersion === 1 &&
    selected.every((part) => version(part.row) === 1)
  )
    return undefined;
  if (currentComponentVersion !== 1 && currentComponentVersion !== 2)
    invariant();
  const reversed = await readPriorRefundReversalsForClientV2(client, scope);
  const reversalComponents = zeroRefundComponentsV2();
  let settlementOnlyMinor = 0;
  const payableAllocations: FrozenRefundAllocationV2["payableAllocations"] = [];
  for (const part of selected) {
    const frozen = readRefundCommercialBasisV2(part.row);
    if (frozen.unclassifiedMinor !== 0) invariant();
    const common = {
      payableId: String(part.row.payable_id),
      payableKind: String(
        part.row.payable_kind,
      ) as FrozenRefundAllocationV2["payableAllocations"][number]["payableKind"],
      commercialRevisionId: frozen.commercialRevisionId,
      componentVersion: frozen.componentVersion,
      basisFingerprint: frozen.basisFingerprint,
      sourceType: String(part.row.source_type),
      sourceId: String(part.row.source_id),
      amountMinor: part.amountMinor,
    };
    if (common.payableKind === "manual_refund") {
      const remainingBefore = zeroRefundComponentsV2();
      for (const key of refundComponentKeysV2)
        remainingBefore[key] = safeMinor(
          frozen.capacities[key] - reversed[key],
        );
      const split = splitRefundComponentsV2(part.amountMinor, remainingBefore);
      for (const key of refundComponentKeysV2) {
        reversed[key] = safeMinor(reversed[key] + split[key]);
        reversalComponents[key] = safeMinor(
          reversalComponents[key] + split[key],
        );
      }
      payableAllocations.push({
        ...common,
        basisCapacities: frozen.capacities,
        remainingBefore,
        reversalComponents: split,
      });
    } else {
      settlementOnlyMinor = safeMinor(settlementOnlyMinor + part.amountMinor);
      payableAllocations.push({
        ...common,
        reversalComponents: zeroRefundComponentsV2(),
      });
    }
  }
  remaining = amountMinor;
  const obligationAllocations = obligationRows.flatMap((row) => {
    const allocated = Math.min(remaining, safeMinor(row.refundable_minor));
    remaining -= allocated;
    return allocated
      ? [{ obligationId: String(row.obligation_id), amountMinor: allocated }]
      : [];
  });
  if (remaining !== 0) invariant();
  return freezeRefundAllocationV2({
    schemaVersion: 2,
    amountMinor,
    reversalComponents,
    settlementOnlyMinor,
    payableAllocations,
    obligationAllocations,
  });
}
