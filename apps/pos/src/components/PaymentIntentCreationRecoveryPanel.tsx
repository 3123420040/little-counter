import { useEffect, useRef, useState } from "react";
import { Button, InlineError } from "@medusa-snus/ui";
import { paymentIntentCreationKeyPrefixV1, type PaymentIntentCreationReceiptV1, type PaymentIntentFinancialViewV1 } from "@medusa-snus/contracts";
import { fetchPaymentIntentCreationReceiptV1, closePaymentIntentCreationReceiptV1 } from "../api/endpoints";
import { isPaymentIntentCartLocked } from "../utils/paymentIntentState";
import { listPendingPaymentIntentCreations, removePendingPaymentIntentCreation, PAYMENT_INTENT_CREATION_RECOVERY_CHANGED,
  type PendingPaymentIntentCreation } from "../utils/paymentIntentCreationRecovery";

export function PaymentIntentCreationRecoveryPanel({ scope, activeRequestKey, onRecover, canClose }: {
  scope: { operatorId: string; merchantId: string; storeId: string; accessEpoch: string };
  activeRequestKey?: string;
  canClose: boolean;
  onRecover: (record: PendingPaymentIntentCreation, intent: PaymentIntentFinancialViewV1) => void;
}) {
  const [records, setRecords] = useState<PendingPaymentIntentCreation[]>([]);
  const [results, setResults] = useState(new Map<string, PaymentIntentCreationReceiptV1>());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const scopeKey = JSON.stringify([scope.operatorId, scope.merchantId, scope.storeId, scope.accessEpoch]);
  const [loadedScope, setLoadedScope] = useState("");
  const latestScope = useRef(scopeKey); latestScope.current = scopeKey;
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  useEffect(() => {
    generation.current++; controller.current?.abort(); setResults(new Map()); setBusy(null);
    const refresh = () => {
      try { setRecords(listPendingPaymentIntentCreations(scope)); setError(""); }
      catch { setRecords([]); setError("Chưa đọc được mã khôi phục thanh toán. Giữ lại dữ liệu và kiểm tra trước khi tạo đơn thay thế."); }
      setLoadedScope(scopeKey);
    };
    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener(PAYMENT_INTENT_CREATION_RECOVERY_CHANGED, refresh);
    return () => {
      generation.current++; controller.current?.abort();
      window.removeEventListener("storage", refresh);
      window.removeEventListener(PAYMENT_INTENT_CREATION_RECOVERY_CHANGED, refresh);
    };
  }, [scopeKey]);
  const visible = records.filter(record => record.operatorId === scope.operatorId && record.merchantId === scope.merchantId
    && record.storeId === scope.storeId && record.idempotencyKey !== activeRequestKey);
  if (loadedScope !== scopeKey) return null;
  if (!visible.length && !error) return null;
  const inspect = async (record: PendingPaymentIntentCreation, close = false) => {
    if (close && (!canClose || scopeKey !== latestScope.current
      || !record.idempotencyKey.startsWith(paymentIntentCreationKeyPrefixV1(scope.operatorId, scope.storeId)))) return;
    if (close && !window.confirm("Server sẽ kiểm tra và chặn mã cũ nếu yêu cầu chưa được thực hiện. Nếu thanh toán đã có, hệ thống sẽ hiển thị nó. Tiếp tục?")) return;
    const captured = generation.current, capturedScope = scopeKey;
    controller.current?.abort(); controller.current = new AbortController();
    const signal = controller.current.signal;
    setBusy(record.idempotencyKey); setError("");
    try {
      const result = await (close ? closePaymentIntentCreationReceiptV1 : fetchPaymentIntentCreationReceiptV1)(record.requestHash, record.idempotencyKey, scope, signal);
      if (captured !== generation.current || signal.aborted || capturedScope !== latestScope.current) return;
      setResults(previous => new Map(previous).set(record.idempotencyKey, result));
      if (close && result.data.status === "closed") removePendingPaymentIntentCreation(record);
    } catch (failure) {
      if (captured === generation.current && !signal.aborted && capturedScope === latestScope.current) setError(failure instanceof Error ? failure.message : "Chưa kiểm tra được thanh toán đã lưu.");
    } finally { if (captured === generation.current && !signal.aborted && capturedScope === latestScope.current) setBusy(null); }
  };
  return <section aria-label="Khôi phục yêu cầu thanh toán" className="space-y-2 border-b border-status-warning-border bg-status-warning-bg p-3 text-sm">
    <p>Có yêu cầu thanh toán đã lưu cần kiểm tra. Giữ nguyên mã cũ; không tạo đơn thay thế khi chưa rõ kết quả.</p>
    {error && <InlineError message={error} />}
    {visible.map(record => {
      const result = results.get(record.idempotencyKey), intent = result?.data.status === "resolved" ? result.data.intent : null;
      return <div key={record.idempotencyKey} className="space-y-2 rounded-md border border-border-default bg-surface-panel p-3">
        <p>{record.provider === "sepay_va" ? "QR tự đối soát" : record.provider === "nowpayments" ? "USDC/USDT" : "Thanh toán thử nghiệm"} · {new Date(record.createdAt).toLocaleString("vi-VN")}</p>
        <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void inspect(record)}>{busy === record.idempotencyKey ? "Đang kiểm tra…" : "Kiểm tra kết quả"}</Button>
        {result?.data.status === "unresolved" && <p>Chưa xác định được kết quả. Mã yêu cầu vẫn được giữ lại; kiểm tra lại khi có kết nối, không tự tạo yêu cầu mới.</p>}
        {result?.data.status === "unresolved" && canClose && record.idempotencyKey.startsWith(paymentIntentCreationKeyPrefixV1(scope.operatorId, scope.storeId))
          && <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void inspect(record, true)}>Kiểm tra và đóng yêu cầu chưa thực hiện</Button>}
        {result?.data.status === "closed" && <>
          <p>Mã yêu cầu cũ đã được đóng trước khi thực hiện và sẽ không tạo thanh toán mới.</p>
          <Button variant="secondary" disabled={Boolean(busy)} onClick={() => {
            try { removePendingPaymentIntentCreation(record); }
            catch { setError("Chưa xóa được mã đã đóng. Kiểm tra lại dữ liệu khôi phục."); }
          }}>Đã kiểm tra kết quả</Button>
        </>}
        {intent && <>
          <p>Đã xác định thanh toán {intent.referenceCode}: {intent.amount.toLocaleString("vi-VN")} ₫.</p>
          <Button variant="secondary" disabled={Boolean(busy)} onClick={() => onRecover(record, intent)}>Xem thanh toán đã ghi nhận</Button>
          {!isPaymentIntentCartLocked(intent.status) && <Button variant="secondary" disabled={Boolean(busy)} onClick={() => {
            try { removePendingPaymentIntentCreation(record); setResults(previous => { const next = new Map(previous); next.delete(record.idempotencyKey); return next; }); }
            catch { setError("Mã khôi phục đã thay đổi; chưa thể xóa kết quả chưa xác minh."); }
          }}>Đã kiểm tra kết quả</Button>}
        </>}
      </div>;
    })}
  </section>;
}
