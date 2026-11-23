import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, PaginatedListFrame, loadedListPaginationMeta, OperationalTable, PageHeader, Panel, ScreenState, StatusPill, TableSkeleton } from "@medusa-snus/ui";
import {
  createPlatformStore,
  fetchPlatformMerchants,
  fetchPlatformStores,
} from "../../api/settings-endpoints";
import { SelectField, TextField } from "../settings/FormField";
import { usePlatformAdmin } from "./usePlatformAdmin";
import { Link } from "react-router-dom";
import { PlatformEntityStatus,PlatformEntityStatusFilter } from "./PlatformEntityStatus";
import type { PlatformEntityStatusFilter as LifecycleFilter } from "../../api/settings-endpoints";

type StoreForm = {
  merchantId: string;
  displayName: string;
  stockLocationName: string;
  isPrimary: boolean;
};

const EMPTY_FORM: StoreForm = {
  merchantId: "",
  displayName: "",
  stockLocationName: "",
  isPrimary: false,
};

export default function PlatformStoresScreen() {
  const { isPlatformAdmin, canWritePlatform } = usePlatformAdmin();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<StoreForm>(EMPTY_FORM);
  const [page, setPage] = useState(1);
  const [lifecycleFilter,setLifecycleFilter]=useState<LifecycleFilter>("all");
  const storesQuery = useQuery({
    queryKey: ["platformStores","directory",lifecycleFilter],
    queryFn: () => fetchPlatformStores(undefined,lifecycleFilter),
    enabled: isPlatformAdmin,
  });
  const merchantsQuery = useQuery({
    queryKey: ["platformMerchants"],
    queryFn: ()=>fetchPlatformMerchants(),
    enabled: isPlatformAdmin && canWritePlatform,
  });
  const stores = storesQuery.data?.data || [];
  const pageMeta = loadedListPaginationMeta(stores.length, page, 20);
  const visibleStores = stores.slice((pageMeta.page - 1) * 20, pageMeta.page * 20);

  useEffect(() => setPage(1), [isPlatformAdmin]);

  useEffect(() => {
    const firstMerchantId = merchantsQuery.data?.data[0]?.merchantId;
    if (firstMerchantId && !form.merchantId) {
      setForm((current) => ({ ...current, merchantId: firstMerchantId }));
    }
  }, [form.merchantId, merchantsQuery.data]);

  const errors = useMemo(() => ({
    merchantId: form.merchantId ? undefined : "Chọn merchant.",
    displayName: form.displayName.trim().length >= 2 ? undefined : "Tên cửa hàng cần ít nhất 2 ký tự.",
  }), [form.displayName, form.merchantId]);
  const hasErrors = Object.values(errors).some(Boolean);
  const mutation = useMutation({
    mutationFn: () => createPlatformStore({
      merchantId: form.merchantId,
      displayName: form.displayName.trim(),
      ...(form.stockLocationName.trim() ? { stockLocationName: form.stockLocationName.trim() } : {}),
      isPrimary: form.isPrimary,
    }),
    onSuccess: () => {
      setForm((current) => ({ ...EMPTY_FORM, merchantId: current.merchantId }));
      queryClient.invalidateQueries({ queryKey: ["platformStores"] });
      queryClient.invalidateQueries({ queryKey: ["platformMerchants"] });
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });

  if (!isPlatformAdmin) {
    return <div className="p-4"><PageHeader title="Cửa hàng" /><ScreenState state="error" title="Không có quyền" /></div>;
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Cửa hàng"
        subtitle="Quản lý cửa hàng và stock location thuộc đúng merchant."
        status={canWritePlatform ? <StatusPill tone="info" label="Có quyền chỉnh sửa" /> : <StatusPill tone="neutral" label="Chỉ đọc" />}
      />
      <div className={canWritePlatform ? "grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(340px,0.7fr)]" : ""}>
        <Panel title="Danh sách cửa hàng">
          <PlatformEntityStatusFilter value={lifecycleFilter} onChange={value=>{setLifecycleFilter(value);setPage(1);}}/>
          {storesQuery.isLoading ? <TableSkeleton rows={6} cols={5} /> : storesQuery.error ? (
            <div className="p-4"><ScreenState state="error" title="Không thể tải" actionLabel="Thử lại" onAction={() => storesQuery.refetch()} /></div>
          ) : !storesQuery.data?.data.length ? (
            <div className="p-4"><ScreenState state="empty" title="Chưa có cửa hàng" /></div>
          ) : (
            <div>
            <PaginatedListFrame
              label="Phân trang cửa hàng"
              rowNoun="cửa hàng"
              meta={pageMeta}
              onPageChange={setPage}
            >
              <OperationalTable
                ariaLabel="Cửa hàng"
                columns={[
                  { key: "name", label: "Tên" },
                  { key: "merchant", label: "Merchant" },
                  { key: "status", label: "Hoạt động hiệu lực" },
                  { key: "scope", label: "Phạm vi" },
                  { key: "location", label: "Vị trí kho" },
                  { key: "created", label: "Tạo lúc" },
                ]}
                rows={visibleStores.map((store) => ({
                  name: <Link className="font-medium text-primary underline break-words" to={`/platform/stores/${encodeURIComponent(store.storeId)}`}>{store.internalName}</Link>,
                  merchant: <Link className="text-primary underline break-words" to={`/platform/merchants/${encodeURIComponent(store.merchantId)}`}>{store.merchantName}</Link>,
                  status:<PlatformEntityStatus status={store.effectiveStatus}/>,
                  scope: <div>{store.isPrimary && <StatusPill tone="info" label="Chính" />}</div>,
                  location: <span className="font-mono text-xs break-all">{store.stockLocationId}</span>,
                  created: (
                    <span className="text-xs text-text-muted">
                      {new Date(store.createdAt).toLocaleDateString("vi-VN")}
                    </span>
                  ),
                }))}
              />
            </PaginatedListFrame>
            </div>
          )}
        </Panel>

        {canWritePlatform && (
          <Panel title="Tạo cửa hàng">
            <div className="space-y-3 p-4">
              <SelectField
                label="Merchant"
                required
                value={form.merchantId}
                error={errors.merchantId}
                disabled={merchantsQuery.isLoading || mutation.isPending}
                onChange={(event) => setForm((current) => ({ ...current, merchantId: event.target.value }))}
              >
                <option value="">Chọn merchant</option>
                {(merchantsQuery.data?.data || []).map((merchant) => (
                  <option key={merchant.merchantId} value={merchant.merchantId}>{merchant.displayName}</option>
                ))}
              </SelectField>
              <TextField
                label="Tên cửa hàng"
                required
                value={form.displayName}
                error={errors.displayName}
                disabled={mutation.isPending}
                onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
              />
              <TextField
                label="Tên vị trí kho"
                value={form.stockLocationName}
                hint="Để trống sẽ dùng tên cửa hàng."
                disabled={mutation.isPending}
                onChange={(event) => setForm((current) => ({ ...current, stockLocationName: event.target.value }))}
              />
              <label className="flex min-h-11 items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={form.isPrimary}
                  disabled={mutation.isPending}
                  onChange={(event) => setForm((current) => ({ ...current, isPrimary: event.target.checked }))}
                />
                Đặt làm cửa hàng chính của merchant
              </label>
              {mutation.error && (
                <ScreenState state="error" title="Không thể tạo cửa hàng" body={mutation.error instanceof Error ? mutation.error.message : "Lỗi không xác định"} />
              )}
              {mutation.isSuccess && <StatusPill tone="success" label="Đã tạo cửa hàng và vị trí kho" />}
              <Button variant="primary" className="w-full" disabled={hasErrors || mutation.isPending} onClick={() => mutation.mutate()}>
                {mutation.isPending ? "Đang tạo..." : "Tạo cửa hàng"}
              </Button>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
