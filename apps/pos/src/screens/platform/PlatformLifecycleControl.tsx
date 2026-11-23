import { useEffect, useRef, useState } from "react";
import { Button, ConfirmDialog } from "@medusa-snus/ui";
import type { PlatformLifecycleCommandV1 } from "@medusa-snus/contracts";
import { ApiError, getToken } from "../../api/client";
import { createClientIdempotencyKey } from "../../api/endpoints";
import { changePlatformEntityStatus } from "../../api/settings-endpoints";
import { TextArea } from "../settings/FormField";

export function PlatformLifecycleControl({ kind, id, name, status, version, parentStatus, onChanged }: {
  kind: "merchant" | "store"; id: string; name: string; status: "active" | "suspended" | "closed";
  version: number; parentStatus?: "active" | "suspended" | "closed"; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false), [reason, setReason] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [conflict, setConflict] = useState(false), [attempted, setAttempted] = useState(false);
  const live = useRef(true), token = useRef(getToken()), pendingRef = useRef(false);
  const attempt = useRef<{ key: string; input: PlatformLifecycleCommandV1 } | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const closed = status === "closed" || parentStatus === "closed";
  const enabling = status === "suspended", parentBlocked = enabling && parentStatus === "suspended";
  async function submit() {
    if (pendingRef.current || conflict || !reason.trim() || closed || parentBlocked || token.current !== getToken()) return;
    pendingRef.current = true; setPending(true); setError("");
    attempt.current ??= { key: createClientIdempotencyKey(`platform-${kind}-status`),
      input: { status: enabling ? "active" : "suspended", expectedVersion: version, reason: reason.trim() } };
    setAttempted(true);
    try {
      await changePlatformEntityStatus(kind, id, attempt.current.input, attempt.current.key);
      if (!live.current || token.current !== getToken()) return;
      setOpen(false); setReason(""); attempt.current = null; setAttempted(false); onChanged();
    } catch (failure) {
      if (!live.current || token.current !== getToken()) return;
      if (failure instanceof ApiError && failure.status === 409) {
        setConflict(true); setError("Trạng thái đã thay đổi hoặc yêu cầu không còn phù hợp. Tải lại chi tiết trước khi thao tác tiếp.");
      } else if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) {
        setConflict(true); setError("Phiên đăng nhập hoặc quyền quản trị đã thay đổi. Tải lại để kiểm tra quyền.");
      } else {
        setError("Chưa xác nhận được kết quả. Thử lại cùng yêu cầu để kiểm tra, hoặc tải lại chi tiết.");
      }
    } finally {
      pendingRef.current = false;
      if (live.current) setPending(false);
    }
  }
  if (closed) return <p className="text-sm text-text-secondary">Đối tượng đã đóng; chỉ được xem lịch sử.</p>;
  return <div className="space-y-3 p-4">
    {parentBlocked && <p className="text-sm text-text-secondary">Cần bật merchant trước khi bật cửa hàng này.</p>}
    <Button variant={enabling ? "primary" : "danger"} disabled={parentBlocked} onClick={() => setOpen(true)}>
      {enabling ? "Bật hoạt động" : "Tắt hoạt động"}
    </Button>
    <ConfirmDialog open={open} title={`${enabling ? "Bật" : "Tắt"} hoạt động ${name}?`}
      message={`${kind === "merchant" ? "Merchant" : "Cửa hàng"}: ${id}. ${enabling
        ? "Cho phép giao dịch mới theo quyền và cấu hình hiện có."
        : "Chặn giao dịch mới; giữ dữ liệu, lịch sử và tiếp tục xử lý thanh toán cũ có đủ bằng chứng."}`}
      confirmLabel={attempted ? "Thử lại yêu cầu" : enabling ? "Xác nhận bật" : "Xác nhận tắt"}
      danger={!enabling} pending={pending} confirmDisabled={!reason.trim() || reason.trim().length > 500 || conflict}
      onConfirm={() => void submit()} onCancel={() => { if (!pendingRef.current) setOpen(false); }}>
      <TextArea label="Lý do thay đổi" value={reason} onChange={event => setReason(event.target.value)}
        maxLength={500} required disabled={pending || attempted} hint="Lý do sẽ được lưu trong lịch sử hoạt động." />
      {error && <p role="alert" className="mt-3 text-sm text-status-danger">{error}</p>}
      {attempted && !pending && <Button variant="secondary" onClick={() => { setOpen(false); onChanged(); }}>Tải lại chi tiết</Button>}
    </ConfirmDialog>
  </div>;
}
