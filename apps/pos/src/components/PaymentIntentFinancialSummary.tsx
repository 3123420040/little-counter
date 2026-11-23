import type { PaymentIntentFinancialViewV1 } from "@medusa-snus/contracts";

export function PaymentIntentFinancialSummary({ financial }: { financial?: PaymentIntentFinancialViewV1["financial"] }) {
  if (!financial || financial.status === "legacy") return null;
  if (financial.status === "unavailable") return <p role="status" className="mt-1 text-xs text-status-warning">
    Chưa xác minh được chi tiết phụ phí. Cần kiểm tra lại; số tiền thanh toán đã chốt vẫn được giữ nguyên.
  </p>;
  const { components, paymentFee } = financial.snapshot;
  const customerFee = components.paymentFeeMinor + (components.taxMode === "exclusive" ? components.paymentFeeVatMinor : 0);
  return <div className="mt-1 text-xs font-normal text-text-muted">
    <p>Phí thanh toán{paymentFee.paymentFeeType === "percent" ? ` (${paymentFee.paymentFeeValue}%)` : ""}: <span className="tabular-nums">{customerFee.toLocaleString("vi-VN")} ₫</span></p>
    <p>VAT của phí{components.taxMode === "inclusive" ? " đã gồm" : " cộng thêm"}: <span className="tabular-nums">{components.paymentFeeVatMinor.toLocaleString("vi-VN")} ₫</span></p>
  </div>;
}
