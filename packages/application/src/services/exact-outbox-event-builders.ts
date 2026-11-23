import type { ExactOutboxWrite } from "../repositories/outbox-repository";

type PersistedTimestamp = Date | string | null | undefined;

function exactSourceOccurredAt(value: PersistedTimestamp): string {
  const epoch = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  if (!Number.isFinite(epoch)) {
    throw new Error("Exact outbox sourceOccurredAt must come from a persisted mutation timestamp");
  }
  return new Date(epoch).toISOString();
}

type CustomerEventInput = {
  merchantId: string;
  customerId: string;
  sourceOccurredAt: PersistedTimestamp;
};

function customerEvent(
  input: CustomerEventInput,
  eventType: "customer.created" | "customer.deleted",
  transition: "created" | "deleted",
): ExactOutboxWrite {
  return {
    merchantId: input.merchantId,
    storeId: null,
    aggregateType: "customer",
    aggregateId: input.customerId,
    eventType,
    eventVersion: 1,
    sourceEventId: `customer:${input.customerId}:${transition}`,
    sourceOccurredAt: exactSourceOccurredAt(input.sourceOccurredAt),
    retryPolicyKey: "workflow-v1",
    payload: {
      customerId: input.customerId,
      merchantId: input.merchantId,
    },
  };
}

export function buildExactCustomerCreatedEvent(input: CustomerEventInput): ExactOutboxWrite {
  return customerEvent(input, "customer.created", "created");
}

export function buildExactCustomerDeletedEvent(input: CustomerEventInput): ExactOutboxWrite {
  return customerEvent(input, "customer.deleted", "deleted");
}

export function buildExactCustomerMergedEvent(input: {
  merchantId: string;
  primaryId: string;
  duplicateId: string;
  sourceOccurredAt: PersistedTimestamp;
}): ExactOutboxWrite {
  return {
    merchantId: input.merchantId,
    storeId: null,
    aggregateType: "customer",
    aggregateId: input.primaryId,
    eventType: "customer.merged",
    eventVersion: 1,
    sourceEventId: `customer:${input.primaryId}:merged:${input.duplicateId}`,
    sourceOccurredAt: exactSourceOccurredAt(input.sourceOccurredAt),
    retryPolicyKey: "workflow-v1",
    payload: {
      primaryId: input.primaryId,
      duplicateId: input.duplicateId,
      merchantId: input.merchantId,
    },
  };
}

export function buildExactJournalPostedEvent(input: {
  merchantId: string;
  storeId: string;
  journalEntryId: string;
  sourceOccurredAt: PersistedTimestamp;
}): ExactOutboxWrite {
  return {
    merchantId: input.merchantId,
    storeId: input.storeId,
    aggregateType: "journal_entry",
    aggregateId: input.journalEntryId,
    eventType: "journal_entry.posted",
    eventVersion: 1,
    sourceEventId: `journal_entry:${input.journalEntryId}:posted`,
    sourceOccurredAt: exactSourceOccurredAt(input.sourceOccurredAt),
    retryPolicyKey: "financial-v1",
    payload: {
      journalEntryId: input.journalEntryId,
      merchantId: input.merchantId,
      storeId: input.storeId,
    },
  };
}

type ShiftEventSourceInput = {
  merchantId: string;
  storeId: string;
  stockLocationId: string;
  shiftId: string;
  shiftEventId: string;
  sourceOccurredAt: PersistedTimestamp;
};

export function buildExactShiftLifecycleEvent(input: ShiftEventSourceInput & {
  eventType: "shift.opened" | "shift.closed" | "shift.force_closed";
}): ExactOutboxWrite {
  return {
    merchantId: input.merchantId,
    storeId: input.storeId,
    aggregateType: "shift",
    aggregateId: input.shiftId,
    eventType: input.eventType,
    eventVersion: 1,
    sourceEventId: `shift_event:${input.shiftEventId}`,
    sourceOccurredAt: exactSourceOccurredAt(input.sourceOccurredAt),
    retryPolicyKey: "workflow-v1",
    payload: {
      shiftId: input.shiftId,
      merchantId: input.merchantId,
      storeId: input.storeId,
      stockLocationId: input.stockLocationId,
    },
  };
}

export function buildExactShiftDiscrepancyAlertEvent(input: ShiftEventSourceInput & {
  zNumber: unknown;
  operatorId: string;
  cashVarianceAmount: number;
  maxStockDiscrepancy: number;
  cashTriggered: boolean;
  stockTriggered: boolean;
}): ExactOutboxWrite {
  return {
    merchantId: input.merchantId,
    storeId: input.storeId,
    aggregateType: "shift",
    aggregateId: input.shiftId,
    eventType: "shift.discrepancy_alert",
    eventVersion: 1,
    sourceEventId: `shift_event:${input.shiftEventId}:discrepancy_alert`,
    sourceOccurredAt: exactSourceOccurredAt(input.sourceOccurredAt),
    retryPolicyKey: "notification-v1",
    payload: {
      shiftId: input.shiftId,
      zNumber: input.zNumber,
      merchantId: input.merchantId,
      storeId: input.storeId,
      stockLocationId: input.stockLocationId,
      operatorId: input.operatorId,
      cashVarianceAmount: input.cashVarianceAmount,
      maxStockDiscrepancy: input.maxStockDiscrepancy,
      cashTriggered: input.cashTriggered,
      stockTriggered: input.stockTriggered,
    },
  };
}

export function buildExactStockChangedEvent(input: {
  merchantId: string;
  storeId: string;
  inventoryItemId: string;
  movementId: string;
  sourceOccurredAt: PersistedTimestamp;
  payload: Record<string, unknown>;
}): ExactOutboxWrite {
  return {
    merchantId: input.merchantId,
    storeId: input.storeId,
    aggregateType: "inventory_item",
    aggregateId: input.inventoryItemId,
    eventType: "stock.changed",
    eventVersion: 1,
    sourceEventId: `stock_movement:${input.movementId}`,
    sourceOccurredAt: exactSourceOccurredAt(input.sourceOccurredAt),
    retryPolicyKey: "inventory-v1",
    payload: {
      ...input.payload,
      merchantId: input.merchantId,
      storeId: input.storeId,
      inventoryItemId: input.inventoryItemId,
      movementId: input.movementId,
    },
  };
}

export function buildExactPurchaseOrderReceivedEvent(input: {
  merchantId: string;
  storeId: string;
  receiptId: string;
  sourceOccurredAt: PersistedTimestamp;
  payload: Record<string, unknown>;
}): ExactOutboxWrite {
  return {
    merchantId: input.merchantId,
    storeId: input.storeId,
    aggregateType: "purchase_order_receipt",
    aggregateId: input.receiptId,
    eventType: "purchase_order.received",
    eventVersion: 1,
    sourceEventId: `purchase_order_receipt:${input.receiptId}`,
    sourceOccurredAt: exactSourceOccurredAt(input.sourceOccurredAt),
    retryPolicyKey: "inventory-v1",
    payload: {
      ...input.payload,
      merchantId: input.merchantId,
      storeId: input.storeId,
      receiptId: input.receiptId,
    },
  };
}

type OrderHandledEventInput = {
  merchantId: string;
  storeId: string;
  orderId: string;
  sourceOccurredAt: PersistedTimestamp;
  payload: Record<string, unknown>;
};

function orderHandledEvent(
  input: OrderHandledEventInput,
  eventType: "sale.created" | "stock.found" | "order.shipping_adjusted" |
    "sale.cancelled" | "refund.created" | "order.corrected",
  sourceEventId: string,
  retryPolicyKey: "financial-v1" | "inventory-v1",
  authoritativePayload: Record<string, unknown> = {},
): ExactOutboxWrite {
  return {
    merchantId: input.merchantId,
    storeId: input.storeId,
    aggregateType: "order",
    aggregateId: input.orderId,
    eventType,
    eventVersion: 1,
    sourceEventId,
    sourceOccurredAt: exactSourceOccurredAt(input.sourceOccurredAt),
    retryPolicyKey,
    payload: {
      ...input.payload,
      merchantId: input.merchantId,
      storeId: input.storeId,
      orderId: input.orderId,
      ...authoritativePayload,
    },
  };
}

export function buildExactSaleCreatedEvent(input: OrderHandledEventInput): ExactOutboxWrite {
  return orderHandledEvent(
    input,
    "sale.created",
    `order:${input.orderId}:created`,
    "financial-v1",
  );
}

export function buildExactStockFoundEvent(input: OrderHandledEventInput): ExactOutboxWrite {
  return orderHandledEvent(
    input,
    "stock.found",
    `order:${input.orderId}:stock_found`,
    "inventory-v1",
  );
}

export function buildExactOrderShippingAdjustedEvent(input: OrderHandledEventInput & {
  auditEventId: string;
}): ExactOutboxWrite {
  return orderHandledEvent(
    input,
    "order.shipping_adjusted",
    `audit_event:${input.auditEventId}`,
    "financial-v1",
    { auditEventId: input.auditEventId },
  );
}

export function buildExactSaleCancelledEvent(input: OrderHandledEventInput): ExactOutboxWrite {
  return orderHandledEvent(
    input,
    "sale.cancelled",
    `order:${input.orderId}:cancelled`,
    "financial-v1",
  );
}

export function buildExactRefundCreatedEvent(input: OrderHandledEventInput & {
  paymentEntryId: string;
}): ExactOutboxWrite {
  return orderHandledEvent(
    input,
    "refund.created",
    `payment_entry:${input.paymentEntryId}:refund_created`,
    "financial-v1",
    { paymentEntryId: input.paymentEntryId },
  );
}

export function buildExactOrderCorrectedEvent(input: OrderHandledEventInput & {
  correctionId: string;
}): ExactOutboxWrite {
  return orderHandledEvent(
    input,
    "order.corrected",
    `order_correction:${input.correctionId}`,
    "financial-v1",
    { correctionId: input.correctionId },
  );
}

export function buildExactProductImageAutofillRequestedEvent(input: {
  merchantId: string;
  storeId: string | null;
  productId: string;
  auditEventId: string;
  sourceOccurredAt: PersistedTimestamp;
  payload: Record<string, unknown>;
}): ExactOutboxWrite {
  return {
    merchantId: input.merchantId,
    storeId: input.storeId,
    aggregateType: "product",
    aggregateId: input.productId,
    eventType: "product.image_autofill_requested",
    eventVersion: 1,
    sourceEventId: `audit_event:${input.auditEventId}`,
    sourceOccurredAt: exactSourceOccurredAt(input.sourceOccurredAt),
    retryPolicyKey: "media-v1",
    payload: {
      ...input.payload,
      merchantId: input.merchantId,
      storeId: input.storeId,
      productId: input.productId,
      auditEventId: input.auditEventId,
    },
  };
}
