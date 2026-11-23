import { useEffect, useRef, useState } from "react";
import { Button } from "@medusa-snus/ui";
import { api, ApiError, getClientScopeSnapshot, SCOPE_CHANGED_EVENT } from "../api/client";

interface Contact { recipient_name: string; phone: string; address: string; retention_until: string }
/** Plaintext lives only in this mounted panel. No query cache, local/session
 * storage, analytics, export or clipboard copy is used for delivery contact. */
export function PartnerDeliveryContactPanel({ orderId, canRead }: { orderId: string; canRead: boolean }) {
  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  function hide() { generation.current++; setContact(null); setLoading(false); setError(""); }
  useEffect(() => {
    hide();
    const clear = () => hide();
    const onVisibility = () => { if (document.visibilityState !== "visible") hide(); };
    window.addEventListener(SCOPE_CHANGED_EVENT, clear);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      generation.current++;
      window.removeEventListener(SCOPE_CHANGED_EVENT, clear);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [orderId, canRead]);
  useEffect(() => {
    if (!contact) return;
    const timer = setTimeout(hide, Math.min(90000, Math.max(0, Date.parse(contact.retention_until) - Date.now())));
    return () => clearTimeout(timer);
  }, [contact]);
  async function reveal() {
    const current = ++generation.current;
    const scope = getClientScopeSnapshot();
    const scopeKey = JSON.stringify([scope.operatingMerchantId, scope.operatingStoreId]);
    setLoading(true); setError("");
    try {
      const response = await api.get<{ data: Contact }>(`/api/platform/admin/orders/${encodeURIComponent(orderId)}/partner-contact`);
      const latest = getClientScopeSnapshot();
      if (current === generation.current && scopeKey === JSON.stringify([latest.operatingMerchantId, latest.operatingStoreId])) {
        setContact(response.data);
      }
    } catch (failure) {
      if (current === generation.current) setError(failure instanceof ApiError && failure.status === 404
        ? "Đơn này không có thông tin giao hàng còn hiệu lực."
        : "Không thể xem thông tin giao hàng. Kiểm tra quyền và cửa hàng đang chọn rồi thử lại.");
    } finally { if (current === generation.current) setLoading(false); }
  }
  if (!canRead) return null;
  return <section aria-label="Thông tin giao hàng đối tác" className="rounded-lg border border-border-default bg-surface-subtle p-3">
    <h3 className="text-sm font-semibold text-text-primary">Giao hàng đối tác</h3>
    <p className="mb-3 mt-1 text-xs text-text-secondary">Chỉ sử dụng cho việc giao đơn này. Mỗi lần xem được ghi nhận.</p>
    {contact ? <div className="space-y-2 text-sm text-text-primary">
      <dl className="space-y-2">
        <div><dt className="text-xs text-text-secondary">Người nhận</dt><dd>{contact.recipient_name}</dd></div>
        <div><dt className="text-xs text-text-secondary">Điện thoại</dt><dd>{contact.phone}</dd></div>
        <div><dt className="text-xs text-text-secondary">Địa chỉ</dt><dd className="whitespace-pre-wrap">{contact.address}</dd></div>
      </dl>
      <p className="text-xs text-text-secondary">Thông tin tự ẩn sau 90 giây hoặc khi đổi cửa hàng.</p>
      <Button variant="secondary" size="sm" onClick={hide}>Ẩn thông tin</Button>
    </div> : <Button variant="secondary" size="sm" disabled={loading} onClick={() => { void reveal(); }}>
      {loading ? "Đang tải…" : "Xem thông tin giao hàng"}
    </Button>}
    {error && <p role="alert" className="mt-2 text-xs text-status-danger">{error}</p>}
  </section>;
}
