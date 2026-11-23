import { useParams, useNavigate } from "react-router-dom";
import {
  Badge, Button, ConfirmDialog, Drawer, InlineError, MetricCell, MutationBanner,
  PageHeader, Panel, ResponsiveMetricGrid, StatusPill,
  PaginatedListFrame, loadedListPaginationMeta,
} from "@medusa-snus/ui";
import { useCustomer, useCustomerOrders, useCustomerLoyalty, useMergeCustomers, useUpdateCustomer, useDeleteCustomer } from "../hooks/useCustomers";
import { usePermission } from "../hooks/usePermissions";
import { ArrowLeft, Trophy, TrendingUp, Clock, AlertTriangle, Edit3, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";

function DetailSkeleton() {
  return (
    <div className="space-y-4 p-4" aria-busy="true">
      <div className="h-8 w-32 rounded bg-surface-subtle animate-pulse" />
      <div className="grid grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[68px] rounded-lg bg-surface-subtle animate-pulse" />
        ))}
      </div>
    </div>
  );
}

export default function CustomerDetailScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const {
    data: customer,
    isLoading: customerLoading,
    error: customerError,
    refetch: refetchCustomer,
  } = useCustomer(id || null);
  const {
    data: ordersResult,
    isLoading: ordersLoading,
    error: ordersError,
    refetch: refetchOrders,
  } = useCustomerOrders(id || null);
  const {
    data: loyalty,
    isLoading: loyaltyLoading,
    error: loyaltyError,
    refetch: refetchLoyalty,
  } = useCustomerLoyalty(id || null);
  const canWriteCustomer = usePermission("customer:write");
  const updateMutation = useUpdateCustomer();
  const deleteMutation = useDeleteCustomer();
  const mergeMutation = useMergeCustomers();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [mergeConfirm, setMergeConfirm] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  const [form, setForm] = useState({ phone: "", firstName: "", lastName: "", email: "" });
  const [mutationNotice, setMutationNotice] = useState<{ tone: "success" | "error" | "pending"; message: string } | null>(null);
  const [ordersPage, setOrdersPage] = useState(1);
  const [loyaltyPage, setLoyaltyPage] = useState(1);

  const orders = ordersResult?.orders || [];
  const totalSpent = Number(ordersResult?.totalRevenue || 0);
  const customerName = customer ? `${customer.last_name || ""} ${customer.first_name || ""}`.trim() : "";
  const loyaltyData = loyaltyError ? undefined : loyalty?.data as {
    points: number; tier: string; nextTierPoints: number | null;
    history: Array<{ pointsEarned: number; pointsRedeemed: number; description: string; tierAtTime: string; createdAt: string }>;
  } | undefined;
  const loyaltyUnavailable = Boolean(loyaltyError);
  const ordersPageMeta = loadedListPaginationMeta((orders || []).length, ordersPage, 10);
  const visibleOrders = (orders || []).slice((ordersPageMeta.page - 1) * 10, ordersPageMeta.page * 10);
  const loyaltyHistory = loyaltyData?.history || [];
  const loyaltyPageMeta = loadedListPaginationMeta(loyaltyHistory.length, loyaltyPage, 10);
  const visibleLoyaltyHistory = loyaltyHistory.slice((loyaltyPageMeta.page - 1) * 10, loyaltyPageMeta.page * 10);

  useEffect(() => {
    setOrdersPage(1);
    setLoyaltyPage(1);
  }, [id]);

  if (customerLoading || ordersLoading) return <DetailSkeleton />;
  if (!id) {
    return (
      <div className="p-4">
        <InlineError message="Không tìm thấy khách hàng" />
      </div>
    );
  }
  if (customerError || ordersError) {
    return (
      <div className="p-4">
        <InlineError
          message={customerError ? "Không thể tải thông tin khách hàng" : "Không thể tải lịch sử mua hàng"}
          onRetry={() => {
            void refetchCustomer();
            void refetchOrders();
          }}
          stale
        />
      </div>
    );
  }

  function openEdit() {
    if (!customer) return;
    setForm({
      phone: customer.phone || "",
      firstName: customer.first_name || "",
      lastName: customer.last_name || "",
      email: customer.email || "",
    });
    setEditOpen(true);
  }

  async function handleUpdate() {
    if (!id || !form.phone.trim() || !form.firstName.trim()) return;
    setMutationNotice({ tone: "pending", message: "Đang cập nhật khách hàng..." });
    try {
      await updateMutation.mutateAsync({
        id,
        phone: form.phone.trim(),
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
      });
      setMutationNotice({ tone: "success", message: "Đã cập nhật khách hàng." });
      setEditOpen(false);
    } catch (err) {
      setMutationNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể cập nhật khách hàng.",
      });
    }
  }

  async function handleDelete() {
    if (!id) return;
    setMutationNotice({ tone: "pending", message: "Đang xóa khách hàng..." });
    try {
      await deleteMutation.mutateAsync(id);
      setMutationNotice({ tone: "success", message: "Đã xóa khách hàng." });
      setDeleteConfirm(false);
      navigate("/customers");
    } catch (err) {
      setMutationNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể xóa khách hàng.",
      });
      setDeleteConfirm(false);
    }
  }

  async function handleMerge() {
    if (!canWriteCustomer || !mergeTarget || !id) return;
    setMutationNotice({ tone: "pending", message: "Đang gộp khách hàng..." });
    try {
      await mergeMutation.mutateAsync({ primaryId: id, duplicateId: mergeTarget });
      setMutationNotice({ tone: "success", message: "Đã gộp khách hàng." });
      setShowMerge(false);
      setMergeConfirm(false);
      setMergeTarget("");
    } catch (err) {
      setMutationNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể gộp khách hàng.",
      });
    }
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title={customerName || "Chi tiết khách hàng"}
        subtitle={customer?.phone || customer?.email || undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            {canWriteCustomer && (
              <Button variant="secondary" onClick={openEdit}>
                <Edit3 size={15} className="mr-1" /> Sửa
              </Button>
            )}
            {canWriteCustomer && (
              <Button variant="danger" onClick={() => setDeleteConfirm(true)}>
                <Trash2 size={15} className="mr-1" /> Xóa
              </Button>
            )}
            <Button variant="secondary" onClick={() => navigate("/customers")}>
              <ArrowLeft size={16} className="mr-1" /> Quay lại
            </Button>
          </div>
        }
      />

      {mutationNotice && (
        <MutationBanner
          tone={mutationNotice.tone}
          message={mutationNotice.message}
          actionLabel={mutationNotice.tone === "error" ? t("state.close") : undefined}
          onAction={() => setMutationNotice(null)}
        />
      )}
      {loyaltyUnavailable && (
        <MutationBanner
          tone="pending"
          message="Dữ liệu điểm thưởng không khả dụng cho quyền hiện tại."
          actionLabel={t("state.retry")}
          onAction={() => void refetchLoyalty()}
        />
      )}

      {/* Metric Row */}
      <ResponsiveMetricGrid>
        <MetricCell
          label={t("customers.totalSpent")}
          value={`${totalSpent.toLocaleString("vi-VN")} ₫`}
          icon={<TrendingUp size={18} />}
        />
        <MetricCell
          label={t("customers.orders")}
          value={String(ordersResult?.totalCount ?? 0)}
          icon={<Clock size={18} />}
        />
        <MetricCell
          label={t("customers.points")}
          value={String(loyaltyData?.points ?? 0)}
          icon={<Trophy size={18} />}
        />
        <MetricCell
          label={t("customers.tier")}
          value={<Badge variant="tier" value={loyaltyData?.tier || "bronze"} />}
        />
      </ResponsiveMetricGrid>

      {/* Tier Progress */}
      {loyaltyData?.nextTierPoints && loyaltyData.nextTierPoints > 0 ? (
        <div className="rounded-lg bg-status-info-bg border border-status-info-border p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-text-primary">{t("customers.tierProgress")}</span>
            <span className="text-text-muted">Còn {loyaltyData.nextTierPoints.toLocaleString("vi-VN")} điểm</span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-surface-page overflow-hidden">
            <div
              className="h-full rounded-full bg-action-primary transition-all"
              style={{
                width: `${Math.min(100, ((loyaltyData.points || 0) / ((loyaltyData.points || 0) + loyaltyData.nextTierPoints)) * 100)}%`,
              }}
            />
          </div>
        </div>
      ) : null}

      {/* History */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={t("customers.purchaseHistory")}>
          <PaginatedListFrame
            label="Phân trang lịch sử mua hàng"
            rowNoun="đơn hàng"
            meta={ordersPageMeta}
            onPageChange={setOrdersPage}
          >
            <div className="space-y-2 max-h-96 overflow-auto p-3">
              {(orders || []).length === 0 ? (
                <p className="py-4 text-center text-xs text-text-muted">Chưa có đơn hàng</p>
              ) : (
                visibleOrders.map((o) => (
                  <div
                    key={o.id}
                    className="flex items-center justify-between rounded border border-border-default p-3 text-sm"
                  >
                    <div>
                      <p className="font-medium text-text-primary">{o.display_id || o.id?.slice(0, 8)}</p>
                      <p className="text-xs text-text-muted">
                        {o.created_at ? new Date(o.created_at).toLocaleDateString("vi-VN") : "-"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium tabular-nums text-text-primary">
                        {(o.total || 0).toLocaleString("vi-VN")} ₫
                      </p>
                      <StatusPill tone="success" label={o.status} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </PaginatedListFrame>
        </Panel>

        <Panel title={t("customers.pointsHistory")}>
          <PaginatedListFrame
            label="Phân trang lịch sử điểm"
            rowNoun="bản ghi"
            meta={loyaltyPageMeta}
            onPageChange={setLoyaltyPage}
          >
            <div className="space-y-2 max-h-96 overflow-auto p-3">
              {(loyaltyData?.history || []).length === 0 ? (
                <p className="py-4 text-center text-xs text-text-muted">Chưa có lịch sử điểm</p>
              ) : (
                visibleLoyaltyHistory.map((h, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between rounded border border-border-default p-3 text-sm"
                  >
                    <div>
                      <p className="font-medium text-text-primary">{h.description || "Điểm thưởng"}</p>
                      <p className="text-xs text-text-muted">
                        {h.createdAt ? new Date(h.createdAt).toLocaleDateString("vi-VN") : "-"}
                      </p>
                    </div>
                    <div className="text-right">
                      <span
                        className={
                          h.pointsEarned > 0
                            ? "text-status-success font-medium"
                            : "text-status-danger font-medium"
                        }
                      >
                        {h.pointsEarned > 0 ? "+" : ""}
                        {h.pointsEarned || -h.pointsRedeemed}
                      </span>
                      <StatusPill tone="info" label={h.tierAtTime} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </PaginatedListFrame>
        </Panel>
      </div>

      {canWriteCustomer && (
        <>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowMerge(!showMerge)}>
              <AlertTriangle size={14} className="mr-1" /> {t("customers.merge")}
            </Button>
          </div>

          {showMerge && (
            <Panel title={t("customers.merge")}>
              <p className="mb-2 text-xs text-text-muted p-3 pb-0">
                Nhập ID khách hàng trùng để gộp vào khách hàng hiện tại
              </p>
              <div className="flex gap-2 p-3 pt-2">
                <input
                  placeholder="Customer ID"
                  value={mergeTarget}
                  onChange={(e) => setMergeTarget(e.target.value)}
                  className="h-9 flex-1 rounded-md border border-border-default bg-surface-panel px-3 text-xs
                             focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                />
                <Button
                  variant="primary"
                  onClick={() => setMergeConfirm(true)}
                  disabled={!mergeTarget.trim() || mergeMutation.isPending}
                >
                  {t("customers.mergeGo")}
                </Button>
              </div>
            </Panel>
          )}
        </>
      )}

      <Drawer
        open={editOpen}
        title="Sửa khách hàng"
        onClose={() => setEditOpen(false)}
        actions={
          <>
            <Button
              variant="primary"
              onClick={handleUpdate}
              disabled={!form.phone.trim() || !form.firstName.trim() || updateMutation.isPending}
            >
              {updateMutation.isPending ? t("state.loading") : t("state.confirm")}
            </Button>
            <Button variant="secondary" onClick={() => setEditOpen(false)}>
              {t("state.cancel")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs text-text-muted">Số điện thoại</label>
            <input
              value={form.phone}
              onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}
              className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-text-muted">Tên</label>
              <input
                value={form.firstName}
                onChange={(event) => setForm((current) => ({ ...current, firstName: event.target.value }))}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">Họ</label>
              <input
                value={form.lastName}
                onChange={(event) => setForm((current) => ({ ...current, lastName: event.target.value }))}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-muted">Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
              className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
            />
          </div>
        </div>
      </Drawer>

      <ConfirmDialog
        open={mergeConfirm}
        title={t("customers.merge")}
        message={t("customers.mergeConfirm")}
        confirmLabel={t("customers.mergeGo")}
        danger
        pending={mergeMutation.isPending}
        confirmDisabled={!mergeTarget.trim()}
        onConfirm={handleMerge}
        onCancel={() => setMergeConfirm(false)}
      />
      <ConfirmDialog
        open={deleteConfirm}
        title="Xóa khách hàng?"
        message="Khách hàng sẽ bị ẩn khỏi danh sách và không thể gán cho đơn mới. Lịch sử đơn hàng cũ vẫn được giữ."
        confirmLabel="Xóa khách hàng"
        danger
        pending={deleteMutation.isPending}
        onConfirm={handleDelete}
        onCancel={() => setDeleteConfirm(false)}
      />
    </div>
  );
}
