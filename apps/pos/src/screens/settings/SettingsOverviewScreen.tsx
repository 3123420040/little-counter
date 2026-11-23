/**
 * SettingsOverviewScreen.tsx
 * Landing page for /settings. Shows merchant identity, active package status,
 * active operating store, and quick links.
 */
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageHeader, Panel, ScreenState, StatusPill, MetricCell, ResponsiveMetricGrid } from "@medusa-snus/ui";
import { Building2, Store, Package, Puzzle, ArrowRight } from "lucide-react";
import { fetchMe, fetchPackagePage, type MeResponse } from "../../api/settings-endpoints";
import { useSettingsOwner } from "./useSettingsOwner";

function statusTone(status: string): "success" | "warning" | "danger" | "info" {
  if (status === "active") return "success";
  if (status === "grace") return "warning";
  if (status === "expired") return "danger";
  return "info";
}

function statusLabel(status: string): string {
  switch (status) {
    case "active": return "Đang hoạt động";
    case "grace": return "Gia hạn (grace)";
    case "expired": return "Hết hạn";
    default: return status;
  }
}

function packageLabel(key: string): string {
  switch (key) {
    case "basic": return "Basic";
    case "plus": return "Plus";
    case "ai_fan": return "AI Fan";
    default: return key;
  }
}

function formatVnd(amount: string | undefined): string {
  if (!amount) return "—";
  const num = Number(amount);
  if (!Number.isFinite(num)) return amount;
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(num);
}

export default function SettingsOverviewScreen() {
  const navigate = useNavigate();
  const { merchantId, isOwner, forbidden } = useSettingsOwner();

  const meQuery = useQuery({ queryKey: ["me"], queryFn: fetchMe, enabled: !forbidden });
  const packageQuery = useQuery({
    queryKey: ["package", merchantId],
    queryFn: () => fetchPackagePage(merchantId!),
    enabled: !!merchantId && isOwner,
  });

  if (forbidden) {
    return (
      <div className="p-4">
        <PageHeader title="Cài đặt" />
        <ScreenState
          state="error"
          title="Bạn không có quyền truy cập mục này"
          body="Chỉ chủ doanh nghiệp mới có thể quản lý cài đặt thương hiệu, cửa hàng và gói dịch vụ."
        />
      </div>
    );
  }

  if (meQuery.isLoading) {
    return (
      <div className="p-4">
        <PageHeader title="Cài đặt" />
        <ScreenState state="loading" title="Đang tải thông tin cài đặt..." />
      </div>
    );
  }

  if (meQuery.error || !meQuery.data) {
    return (
      <div className="p-4">
        <PageHeader title="Cài đặt" />
        <ScreenState
          state="error"
          title="Không thể tải thông tin cài đặt"
          body="Vui lòng thử lại. Nếu vẫn lỗi, liên hệ quản trị viên nền tảng."
          actionLabel="Thử lại"
          onAction={() => meQuery.refetch()}
        />
      </div>
    );
  }

  const me: MeResponse = meQuery.data;
  const pkg = packageQuery.data?.data;
  const merchant = me.merchant;

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Cài đặt"
        subtitle={merchant ? merchant.displayName : "Tài khoản của bạn"}
        status={
          merchant ? (
            <>
              <StatusPill tone="info" label={packageLabel(merchant.packageKey)} />
              <StatusPill tone={statusTone(merchant.subscriptionStatus)} label={statusLabel(merchant.subscriptionStatus)} />
            </>
          ) : undefined
        }
      />

      {merchant && (
        <ResponsiveMetricGrid>
          <MetricCell
            label="Thương hiệu"
            value={merchant.displayName}
            icon={<Building2 size={20} />}
          />
          <MetricCell
            label="Gói hiện tại"
            value={packageLabel(merchant.packageKey)}
            icon={<Package size={20} />}
          />
          <MetricCell
            label="Trạng thái"
            value={statusLabel(merchant.subscriptionStatus)}
            tone={statusTone(merchant.subscriptionStatus)}
          />
          {pkg?.currentStatus.renewalDate ? (
            <MetricCell
              label="Ngày gia hạn"
              value={new Date(pkg.currentStatus.renewalDate).toLocaleDateString("vi-VN")}
            />
          ) : null}
        </ResponsiveMetricGrid>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          title="Cửa hàng của bạn"
          action={isOwner ? (
            <button className="settings-link" onClick={() => navigate("/settings/stores")}>
              Quản lý <ArrowRight size={12} />
            </button>
          ) : undefined}
        >
          <div className="space-y-2 p-4 text-sm">
            {me.stores.length === 0 ? (
              <p className="text-text-muted">Chưa có cửa hàng nào được cấu hình.</p>
            ) : (
              me.stores.map((store) => (
                <div key={store.storeId} className="flex items-center justify-between gap-3 rounded-lg border border-border-default p-2">
                  <span className="flex items-center gap-2 min-w-0">
                    <Store size={14} className="text-text-muted shrink-0" />
                    <span className="truncate font-medium text-text-primary">{store.displayName}</span>
                  </span>
                  {store.isPrimary && <StatusPill tone="info" label="Cửa hàng chính" />}
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          title="Gói dịch vụ"
          action={isOwner ? (
            <button className="settings-link" onClick={() => navigate("/settings/package")}>
              Chi tiết <ArrowRight size={12} />
            </button>
          ) : undefined}
        >
          <div className="space-y-3 p-4 text-sm">
            {!isOwner ? (
              <p className="text-text-muted">Chỉ chủ doanh nghiệp mới có thể xem và thay đổi gói.</p>
            ) : !pkg ? (
              <ScreenState state="loading" title="Đang tải gói..." />
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">Gói hiện tại</span>
                  <StatusPill tone="info" label={packageLabel(pkg.currentStatus.currentPackageKey)} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">Giá/năm (đã gồm thuế)</span>
                  <span className="font-semibold tabular-nums">{formatVnd(pkg.currentStatus.annualPriceVnd)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">Tương đương/tháng</span>
                  <span className="tabular-nums">{formatVnd(pkg.currentStatus.monthlyEquivalentVnd)}</span>
                </div>
              </>
            )}
          </div>
        </Panel>
      </div>

      {isOwner && (
        <Panel title="Tích hợp">
          <div className="space-y-2 p-4 text-sm">
            <div className="flex items-center gap-2 text-text-muted">
              <Puzzle size={14} />
              <span>Xem trạng thái SePay, NOWPayments, Telegram và các tích hợp khác.</span>
            </div>
            <button className="settings-link" onClick={() => navigate("/settings/integrations")}>
              Xem tích hợp <ArrowRight size={12} />
            </button>
          </div>
        </Panel>
      )}
    </div>
  );
}
