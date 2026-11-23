import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExactShiftDiscrepancyAlertEvent,
  buildExactShiftLifecycleEvent,
} from "../services/exact-outbox-event-builders";

const source = {
  merchantId: "merchant_a",
  storeId: "store_a",
  stockLocationId: "stock_a",
  shiftId: "shift_a",
  shiftEventId: "shiftevt_a",
  sourceOccurredAt: new Date("2026-08-06T04:00:00.000Z"),
};

describe("OUTBOX-02B exact shift aggregate conversion", () => {
  it("keeps lifecycle no-op payloads at the DEC-32 identity/scope boundary", () => {
    for (const eventType of ["shift.opened", "shift.closed", "shift.force_closed"] as const) {
      const event = buildExactShiftLifecycleEvent({ ...source, eventType });
      expect(event).toMatchObject({
        merchantId: source.merchantId,
        storeId: source.storeId,
        aggregateType: "shift",
        aggregateId: source.shiftId,
        eventType,
        eventVersion: 1,
        sourceEventId: `shift_event:${source.shiftEventId}`,
        sourceOccurredAt: "2026-08-06T04:00:00.000Z",
        retryPolicyKey: "workflow-v1",
        payload: {
          shiftId: source.shiftId,
          merchantId: source.merchantId,
          storeId: source.storeId,
          stockLocationId: source.stockLocationId,
        },
      });
      expect(JSON.stringify(event.payload)).not.toMatch(/reason|note|operator|variance|zNumber/i);
    }
  });

  it("preserves the handled discrepancy notification payload with a unique derived source identity", () => {
    const event = buildExactShiftDiscrepancyAlertEvent({
      ...source,
      zNumber: 12,
      operatorId: "operator_a",
      cashVarianceAmount: -1000,
      maxStockDiscrepancy: 2,
      cashTriggered: true,
      stockTriggered: true,
    });
    expect(event).toMatchObject({
      aggregateType: "shift",
      aggregateId: source.shiftId,
      eventType: "shift.discrepancy_alert",
      eventVersion: 1,
      sourceEventId: `shift_event:${source.shiftEventId}:discrepancy_alert`,
      retryPolicyKey: "notification-v1",
      payload: {
        shiftId: source.shiftId,
        zNumber: 12,
        merchantId: source.merchantId,
        storeId: source.storeId,
        stockLocationId: source.stockLocationId,
        operatorId: "operator_a",
        cashVarianceAmount: -1000,
        maxStockDiscrepancy: 2,
        cashTriggered: true,
        stockTriggered: true,
      },
    });
  });

  it("fails closed without an immutable shift-event occurrence", () => {
    expect(() => buildExactShiftLifecycleEvent({
      ...source,
      eventType: "shift.closed",
      sourceOccurredAt: null,
    })).toThrow("sourceOccurredAt");
  });

  it("binds the whole live shift aggregate to exact writes and returned shift-event time", () => {
    const servicePath = path.resolve(import.meta.dirname, "../services/shift-service.ts");
    const serviceSource = fs.readFileSync(servicePath, "utf8");
    expect(serviceSource).not.toContain("emitOutbox(");
    expect(serviceSource.match(/\bemitExactOutbox\(/g)).toHaveLength(4);
    expect(serviceSource).toMatch(/INSERT INTO app\.shift_events[\s\S]*RETURNING id, created_at/i);
    expect(serviceSource).toContain("shiftEventId:");
    expect(serviceSource).toContain("sourceOccurredAt:");
  });
});
