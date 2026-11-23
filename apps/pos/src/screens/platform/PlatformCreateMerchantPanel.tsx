import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createPlatformMerchantSchema, type CreatePlatformMerchantInput, type CreatedPlatformMerchant } from "@medusa-snus/contracts";
import { Button, ConfirmDialog, Panel, ScreenState } from "@medusa-snus/ui";
import { ApiError } from "../../api/client";
import { createClientIdempotencyKey } from "../../api/endpoints";
import { createPlatformMerchant } from "../../api/settings-endpoints";
import { TextField } from "../settings/FormField";
import { usePlatformAdmin } from "./usePlatformAdmin";

type Intent = { input: CreatePlatformMerchantInput; key: string };
const emptyForm: CreatePlatformMerchantInput = {
  displayName: "", storeName: "", ownerOperatorId: "", timezone: "Asia/Ho_Chi_Minh",
};

function savedIntent(storageKey: string): Intent | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    const parsed = createPlatformMerchantSchema.safeParse(saved?.input);
    return parsed.success && typeof saved.key === "string" && saved.key.length > 0
      ? { input: parsed.data, key: saved.key } : null;
  } catch { return null; }
}

export function PlatformCreateMerchantPanel() {
  const { operator, isPlatformAdmin, canWritePlatform } = usePlatformAdmin();
  const storageKey = `snus_platform_merchant_create:${operator?.id || ""}`;
  const queryClient = useQueryClient();
  const [intent, setIntent] = useState(() => savedIntent(storageKey));
  const intentRef = useRef(intent);
  const inFlight = useRef(false);
  const [form, setForm] = useState(() => intent?.input || emptyForm);
  const [review, setReview] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [created, setCreated] = useState<CreatedPlatformMerchant | null>(null);
  const validation = createPlatformMerchantSchema.safeParse(form);
  const errors = validation.success ? {} : Object.fromEntries(validation.error.issues.map((issue) => [issue.path[0], issue.message]));
  const clearIntent = (key: string) => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored && JSON.parse(stored).key !== key) return false;
      sessionStorage.removeItem(storageKey);
    }
    catch { setStorageError("Không xóa được trạng thái yêu cầu. Khôi phục lưu trữ phiên rồi thử lại cùng yêu cầu."); return false; }
    intentRef.current = null; setIntent(null); setStorageError("");
    return true;
  };
  const mutation = useMutation({
    mutationFn: (request: Intent) => createPlatformMerchant(request.input, request.key),
    onSuccess: ({ data }, request) => {
      setCreated(data); setReview(false);
      if (clearIntent(request.key)) setForm(emptyForm);
      for (const key of ["platformMerchants", "platformStores", "platformMemberships", "me"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (error, request) => {
      setReview(false);
      if (error instanceof ApiError && ["owner_not_available", "validation_error"].includes(error.code || "")) clearIntent(request.key);
    },
    onSettled: () => { inFlight.current = false; },
  });

  if (!isPlatformAdmin || !canWritePlatform) return null;

  function confirm() {
    if (!validation.success || inFlight.current || mutation.isPending || !operator?.id) return;
    const request = intentRef.current || { input: validation.data, key: createClientIdempotencyKey("platform-merchant") };
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setStorageError("Không lưu được mã yêu cầu. Cho phép trình duyệt lưu dữ liệu phiên trước khi tạo merchant."); return; }
    inFlight.current = true; setStorageError(""); intentRef.current = request; setIntent(request); mutation.mutate(request);
  }

  return (
    <Panel title="Tạo merchant">
      <div className="space-y-3 p-4">
        <p className="text-sm text-text-muted">Tạo merchant với một cửa hàng chính, kho và gói Basic. Owner phải là tài khoản đã có; quyền và mật khẩu hiện tại của họ được giữ nguyên.</p>
        {([
          ["displayName", "Tên merchant", 120], ["storeName", "Tên cửa hàng đầu tiên", 120],
          ["ownerOperatorId", "Username của owner", 160], ["timezone", "Múi giờ", 64],
        ] as const).map(([field,label,maxLength]) => (
          <TextField key={field} name={field} label={label} required maxLength={maxLength}
            value={form[field]} error={errors[field]} disabled={mutation.isPending || Boolean(intent)}
            hint={field === "ownerOperatorId" ? "Nhập đúng username tài khoản đang hoạt động." : field === "timezone" ? "Ví dụ: Asia/Ho_Chi_Minh." : undefined}
            onChange={(event) => { mutation.reset(); setCreated(null); setForm((current) => ({ ...current, [field]: event.target.value })); }} />
        ))}
        {intent && <p role="status" className="text-sm">{created ? "Yêu cầu đã hoàn tất; thử lại để dọn trạng thái lưu." : "Đang giữ yêu cầu chưa xác định kết quả. Thử lại cùng yêu cầu để tránh tạo trùng."}</p>}
        {mutation.error && <ScreenState state="error" title="Chưa hoàn tất yêu cầu" body={mutation.error.message} />}
        {storageError && <ScreenState state="error" title="Chưa gửi yêu cầu" body={storageError} />}
        {created && <div role="status" className="space-y-1 text-sm">
          <p>Đã tạo merchant: <strong>{created.merchantId}</strong></p>
          <p>Cửa hàng: {created.storeId} · Owner: {created.ownerOperatorId} · Gói Basic</p>
        </div>}
        <Button variant="primary" disabled={!validation.success || mutation.isPending || !operator?.id} onClick={() => setReview(true)}>
          {mutation.isPending ? "Đang tạo..." : intent ? "Thử lại yêu cầu" : "Xem lại và tạo"}
        </Button>
      </div>
      <ConfirmDialog open={review} title="Xác nhận tạo merchant" confirmLabel="Xác nhận tạo merchant"
        message={`${form.displayName} — ${form.storeName}. ${form.ownerOperatorId} sẽ có quyền owner của merchant mới. Múi giờ: ${form.timezone}. Gói Basic; danh mục và tồn kho ban đầu trống.`}
        pending={mutation.isPending} confirmDisabled={!validation.success || mutation.isPending}
        onConfirm={confirm} onCancel={() => { if (!mutation.isPending) setReview(false); }} />
    </Panel>
  );
}
