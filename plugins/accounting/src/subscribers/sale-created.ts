import type { InMemoryStoreAdapter, OutboxEvent } from "@medusa-snus/application";
import { AccountingService } from "../services/accounting-service";
import { calculateCogs } from "@medusa-snus/domain";

/**
 * @deprecated Legacy in-memory subscriber. Production outbox accounting is
 * handled by the PostgreSQL-backed application outbox processor.
 */
export async function handleSaleCreatedForAccounting(
  event: OutboxEvent,
  store: InMemoryStoreAdapter,
): Promise<void> {
  const svc = new AccountingService(store);
  const { orderId, orderNumber, total, paymentMethod, items } = event.payload as Record<string, unknown>;

  const debitAccount = paymentMethod === "cash" ? "1111" : "1121";

  // P1-1 fix: use costPrice from items' variants, fallback to unitPrice * 0.7 only if no costPrice
  const cogs = calculateCogs(
    (items as Array<Record<string, unknown>> || []).map(i => {
      const quantity = Number(i.quantity) || 0;
      const variantId = String(i.variantId || "");
      const unitPrice = Number(i.unitPrice || 0);
      // Try to get costPrice from store, fallback to estimate
      const variant = store.state.products.flatMap(p => p.variants).find(v => v.id === variantId);
      const costPrice = variant?.costPrice ?? unitPrice * 0.7;
      return { quantity, unitCost: costPrice };
    }),
  );

  await svc.createJournalEntry({
    entryDate: new Date(event.occurredAt).toISOString().slice(0, 10),
    referenceType: "order",
    referenceId: orderId as string | undefined,
    description: `Ban hang - Don ${orderNumber || orderId}`,
    createdBy: "system",
    autoPost: true,
    lines: [
      { accountCode: debitAccount, debitAmount: Number(total) || 0, creditAmount: 0, description: "Cash/Bank" },
      { accountCode: "5111", debitAmount: 0, creditAmount: Number(total) || 0, description: "Sales Revenue" },
      { accountCode: "6321", debitAmount: cogs, creditAmount: 0, description: "COGS" },
      { accountCode: "1561", debitAmount: 0, creditAmount: cogs, description: "Inventory" },
    ],
  });
}

/**
 * @deprecated Legacy in-memory subscriber. Production cancellation accounting is
 * handled by the PostgreSQL-backed application outbox processor.
 */
export async function handleSaleCancelledForAccounting(
  event: OutboxEvent,
  store: InMemoryStoreAdapter,
): Promise<void> {
  const svc = new AccountingService(store);
  const { orderId, total, reason } = event.payload as Record<string, unknown>;

  // P1-2 fix: use actual order total from event payload, not hardcoded 480000
  const reversalAmount = Number(total) || 0;

  await svc.createJournalEntry({
    entryDate: new Date().toISOString().slice(0, 10),
    referenceType: "order",
    referenceId: orderId as string | undefined,
    description: `Hoan don - ${reason || "Cancelled"}`,
    createdBy: "system",
    autoPost: true,
    lines: [
      { accountCode: "5111", debitAmount: reversalAmount, creditAmount: 0 },
      { accountCode: "1111", debitAmount: 0, creditAmount: reversalAmount },
    ],
  });
}

/**
 * @deprecated Legacy in-memory subscriber. Production payment accounting is
 * handled by the PostgreSQL-backed payment ledger and accounting services.
 */
export async function handlePaymentReceived(
  event: OutboxEvent,
  store: InMemoryStoreAdapter,
): Promise<void> {
  const svc = new AccountingService(store);
  const { orderId, amount, method } = event.payload as Record<string, unknown>;
  const acct = method === "cash" ? "1111" : "1121";
  await svc.createJournalEntry({
    entryDate: new Date().toISOString().slice(0, 10),
    referenceType: "payment",
    referenceId: orderId as string | undefined,
    description: "Ghi nhan thanh toan",
    createdBy: "system",
    autoPost: true,
    lines: [
      { accountCode: acct, debitAmount: Number(amount) || 0, creditAmount: 0 },
      { accountCode: "1311", debitAmount: 0, creditAmount: Number(amount) || 0 },
    ],
  });
}
