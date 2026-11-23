import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../services/shift-service.ts", import.meta.url),
  "utf8",
);

describe("shift canonical commercial and cash sources", () => {
  it("reads latest immutable commercial revisions for totals and products", () => {
    expect(source).toContain("FROM app.order_commercial_revisions revision");
    expect(source).toContain("JOIN app.order_commercial_revision_components components");
    expect(source).toContain("JOIN app.order_commercial_revision_lines line");
    expect(source).toContain("revision.commercial_state = 'active'");
    expect(source).not.toContain("COALESCE(o.metadata->>'total', '0') AS total");
    expect(source).not.toContain("FROM public.order_item oi");
  });

  it("counts posted receipts and effective receivables at a single economic and recording cutoff", () => {
    const paymentBlock = source.slice(
      source.indexOf("const paymentSummary"),
      source.indexOf("const cashMovementRows"),
    );
    expect(paymentBlock).toContain("FROM app.payment_events");
    expect(paymentBlock).toContain("source_occurred_at >= $3::timestamptz");
    expect(paymentBlock).toContain("source_occurred_at <= COALESCE($4::timestamptz, now())");
    expect(paymentBlock).toContain("AND status = 'posted'");
    expect(paymentBlock).toContain("FROM app.commercial_obligations obligations");
    expect(paymentBlock).toContain("FROM app.order_commercial_revisions revision");
    expect(paymentBlock).toContain("revision.commercial_state = 'cancelled' THEN 0");
    expect(paymentBlock).toContain("revision.recorded_at <= $4::timestamptz");
    expect(paymentBlock).toContain("events.source_occurred_at <= $4::timestamptz AND events.recorded_at <= $4::timestamptz");
    expect(paymentBlock).toContain("app.customer_refund_payables payable");
    expect(paymentBlock).toContain("clearance.event_kind = 'clear'");
    expect(paymentBlock).not.toContain("FROM app.payment_entries");

  });
});
