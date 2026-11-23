export const operationalOrderFixture = {
  schemaVersion: 1 as const, id: "order/a", merchantId: "m-a", storeId: "s-a", paymentMethod: "manual_bank", paymentStatus: "posted", manualBankConfirmationEnabled: true,
  paymentEntries: [{ id: "pay-a", direction: "charge", method: "manual_bank", amount: 240320, currencyCode: "VND", status: "pending",
    effectiveStatus: "posted" as const, collectedAmountMinor: 240320, remainingAmountMinor: 0,
    reference: "BANK-REFERENCE", reason: null, createdBy: "owner-a", createdAt: "2026-10-30T08:31:19.595Z" }],
  canonicalPaymentSummary: { recordedGrossCollectionsMinor: 240320, refundsMinor: 0, reversalsMinor: 0, chargebacksMinor: 0, negativeCollectionsMinor: 0, netCollectionsMinor: 240320, customerRefundPayableMinor: 0 },
  cancellationAccess: { allowed: false, mode: null, reasonCode: "scope_required" },
  notes: "Delivery after noon", salesChannel: "pos_counter", salesChannelLabel: "Tại quầy", salesChannelLocked: false, salesChannelLockReason: null, sourceFlow: null,
  createdBy: { operatorId: "owner-a", actorType: "staff" as const, actorId: "owner-a", displayName: "Owner", role: "owner", channel: null, channelUserId: null, serviceIdentity: null, createdAt: "2026-10-30T08:31:19.595Z" },
  stockAdjustments: [{ type: "found_stock", adjustedQuantity: 1, unitCost: 50000 }],
  correctionSummary: { latestRevision: 1, effectiveTotal: 240320, hasPendingSettlement: false },
  corrections: [{ id: "correction-a", revision: 1, status: "applied", reason: "Quantity corrected", totalDelta: -1000, createdAt: "2026-10-30T09:31:19.595Z" }],
};
