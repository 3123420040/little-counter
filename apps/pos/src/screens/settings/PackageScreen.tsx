import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, PageHeader, Panel, ScreenState, StatusPill } from "@medusa-snus/ui";
import { fetchPackagePage, requestPackageUpgrade, type PackageCatalogEntryDto, type PackageStatusDto } from "../../api/settings-endpoints";
import { useSettingsOwner } from "./useSettingsOwner";
import type { PackageKey, SubscriptionStatus } from "@medusa-snus/contracts";
import {
  PACKAGE_COMPARISON_ROWS,
  PACKAGE_PAYMENT_POLICY_COPY,
  type PackageComparisonRow,
} from "./package-comparison";

// Per commercial spec: prices are tax-inclusive, no marketing layout
function formatVnd(v: string | undefined) {
  if (!v) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("vi-VN") + "₫" : v;
}

function pkgLabel(k: PackageKey): string {
  return k === "basic" ? "Basic" : k === "plus" ? "Plus" : "AI Fan";
}

function subStatusBanner(status: SubscriptionStatus, graceEndsAt: string | null, renewalDate: string | null) {
  if (status === "active") return null;
  if (status === "grace") {
    return (
      <div className="pkg-banner pkg-banner--warning" role="alert">
        <strong>Gói đang trong thời gian gia hạn (grace period).</strong>
        {graceEndsAt ? ` Vui lòng gia hạn trước ${new Date(graceEndsAt).toLocaleDateString("vi-VN")}.` : ""}
        {" "}Dữ liệu và tính năng đã mua vẫn truy cập được; POS cơ bản vẫn hoạt động.
      </div>
    );
  }
  if (status === "expired") {
    return (
      <div className="pkg-banner pkg-banner--danger" role="alert">
        <strong>Gói đã hết hạn.</strong> Các tính năng nâng cao đã bị khóa; dữ liệu được giữ nguyên.
        Gia hạn để khôi phục quyền truy cập đầy đủ.
      </div>
    );
  }
  return null;
}

type UpgradeState = "idle" | "confirm" | "pending" | "done" | "error";

interface UsageRowProps { label: string; used: number; limit: number | null; }
function UsageRow({ label, used, limit }: UsageRowProps) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const tone = pct !== null && pct >= 90 ? "danger" : pct !== null && pct >= 70 ? "warning" : "success";
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="min-w-0 flex-1 text-text-muted break-words">{label}</span>
      <span className="tabular-nums text-text-primary shrink-0">{used.toLocaleString("vi-VN")}{limit !== null ? ` / ${limit.toLocaleString("vi-VN")}` : ""}</span>
      {pct !== null && <StatusPill tone={tone} label={`${pct}%`} />}
    </div>
  );
}

function ComparisonRow({ feature, basic, plus, aiFan }: PackageComparisonRow) {
  const tick = (v?: boolean) => v ? <span className="text-status-success font-bold" aria-label="Có">✓</span> : <span className="text-text-muted" aria-label="Không">—</span>;
  return (
    <tr className="border-b border-border-default">
      <td className="py-2 px-3 text-sm text-text-secondary break-words">{feature}</td>
      <td className="py-2 px-3 text-center">{tick(basic)}</td>
      <td className="py-2 px-3 text-center">{tick(plus)}</td>
      <td className="py-2 px-3 text-center">{tick(aiFan)}</td>
    </tr>
  );
}

export default function PackageScreen() {
  const { merchantId, isOwner } = useSettingsOwner();
  const queryClient = useQueryClient();
  const [upgradeTarget, setUpgradeTarget] = useState<PackageKey | null>(null);
  const [upgradeState, setUpgradeState] = useState<UpgradeState>("idle");
  const [upgradeError, setUpgradeError] = useState<string>("");

  const query = useQuery({
    queryKey: ["package", merchantId],
    queryFn: () => fetchPackagePage(merchantId!),
    enabled: !!merchantId && isOwner,
  });

  const mutation = useMutation({
    mutationFn: () => requestPackageUpgrade(merchantId!, upgradeTarget!),
    onSuccess: (res) => {
      setUpgradeState("done");
      if (res.data.paymentUrl) window.location.href = res.data.paymentUrl;
      queryClient.invalidateQueries({ queryKey: ["package", merchantId] });
    },
    onError: (err: unknown) => {
      setUpgradeState("error");
      setUpgradeError(err instanceof Error ? err.message : "Lỗi không xác định.");
    },
  });

  if (!isOwner) return <div className="p-4"><PageHeader title="Gói dịch vụ" /><ScreenState state="error" title="Không có quyền" /></div>;
  if (query.isLoading) return <div className="p-4"><PageHeader title="Gói dịch vụ" /><ScreenState state="loading" title="Đang tải thông tin gói..." /></div>;
  if (query.error || !query.data?.data) return <div className="p-4"><PageHeader title="Gói dịch vụ" /><ScreenState state="error" title="Không thể tải thông tin gói" actionLabel="Thử lại" onAction={() => query.refetch()} /></div>;

  const pkg = query.data.data;
  const status: PackageStatusDto = pkg.currentStatus;
  const catalog: PackageCatalogEntryDto[] = pkg.catalog;
  const canAct = pkg.canUpgrade || pkg.canRenew;

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Gói dịch vụ"
        subtitle="Giá đã bao gồm thuế. Mọi thanh toán qua NOWPayments."
        status={
          <>
            <StatusPill tone="info" label={pkgLabel(status.currentPackageKey)} />
            <StatusPill
              tone={status.subscriptionStatus === "active" ? "success" : status.subscriptionStatus === "grace" ? "warning" : "danger"}
              label={status.subscriptionStatus === "active" ? "Đang hoạt động" : status.subscriptionStatus === "grace" ? "Grace period" : "Hết hạn"}
            />
          </>
        }
      />

      {subStatusBanner(status.subscriptionStatus, status.graceEndsAt, status.renewalDate)}

      {/* Current plan summary */}
      <Panel title="Gói hiện tại">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 sm:grid-cols-4 text-sm">
          <div>
            <p className="text-text-muted">Gói</p>
            <p className="font-semibold break-words">{pkgLabel(status.currentPackageKey)}</p>
          </div>
          <div>
            <p className="text-text-muted">Giá/năm (đã thuế)</p>
            <p className="font-semibold tabular-nums">{formatVnd(status.annualPriceVnd)}</p>
          </div>
          <div>
            <p className="text-text-muted">Tương đương/tháng</p>
            <p className="tabular-nums">{formatVnd(status.monthlyEquivalentVnd)}</p>
          </div>
          <div>
            <p className="text-text-muted">Ngày gia hạn</p>
            <p className="tabular-nums">{status.renewalDate ? new Date(status.renewalDate).toLocaleDateString("vi-VN") : "—"}</p>
          </div>
        </div>
      </Panel>

      {/* Usage */}
      {status.usage.length > 0 && (
        <Panel title="Sử dụng trong kỳ">
          <div className="space-y-2 p-4">
            {status.usage.map((row) => (
              <UsageRow key={row.metricKey} label={row.label} used={row.used} limit={row.limit} />
            ))}
          </div>
        </Panel>
      )}

      {/* Comparison matrix — operational list, not hero/pricing-card */}
      <Panel title="So sánh gói">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" role="table" aria-label="So sánh gói dịch vụ">
            <thead>
              <tr className="border-b border-border-default bg-surface-subtle">
                <th className="py-2 px-3 text-left text-text-muted font-semibold">Tính năng</th>
                {catalog.map((c) => (
                  <th key={c.packageKey} className="py-2 px-3 text-center text-text-muted font-semibold min-w-[90px]">
                    <span className="block break-words">{pkgLabel(c.packageKey)}</span>
                    <span className="block tabular-nums text-xs text-text-secondary">{formatVnd(c.monthlyEquivalentVnd)}/th</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PACKAGE_COMPARISON_ROWS.map((row) => (
                <ComparisonRow key={row.feature} {...row} />
              ))}
              <tr className="border-b border-border-default">
                <td className="py-2 px-3 text-sm text-text-muted">Số cửa hàng</td>
                {catalog.map((c) => (
                  <td key={c.packageKey} className="py-2 px-3 text-center tabular-nums text-text-primary">{c.includedStores}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Single upgrade/renew action panel */}
      {canAct && (
        <Panel title={pkg.canRenew ? "Gia hạn gói" : "Nâng cấp gói"}>
          <div className="space-y-3 p-4">
            {upgradeState === "done" ? (
              <div className="text-sm text-status-success">
                Yêu cầu đã được gửi. Gói sẽ được cập nhật sau khi xác nhận thanh toán thành công.
              </div>
            ) : upgradeState === "error" ? (
              <div className="space-y-2">
                <ScreenState state="error" title="Không thể gửi yêu cầu" body={upgradeError} />
                <Button variant="secondary" size="sm" onClick={() => setUpgradeState("idle")}>Thử lại</Button>
              </div>
            ) : upgradeState === "confirm" && upgradeTarget ? (
              <div className="space-y-3">
                <p className="text-sm text-text-primary">
                  Xác nhận {pkg.canRenew ? "gia hạn" : "nâng cấp lên"} gói <strong>{pkgLabel(upgradeTarget)}</strong>?
                  Bạn sẽ được chuyển đến trang thanh toán NOWPayments.
                </p>
                <p className="text-xs text-text-muted">
                  {PACKAGE_PAYMENT_POLICY_COPY}
                </p>
                <div className="flex gap-2 flex-wrap">
                  <Button variant="primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
                    {mutation.isPending ? "Đang xử lý..." : "Xác nhận & Thanh toán"}
                  </Button>
                  <Button variant="secondary" disabled={mutation.isPending} onClick={() => setUpgradeState("idle")}>Hủy</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-text-muted">
                  {pkg.canRenew ? "Gia hạn gói hiện tại hoặc nâng cấp lên gói cao hơn." : "Chọn gói muốn nâng cấp."}
                </p>
                <div className="flex gap-2 flex-wrap">
                  {catalog.filter((c) => {
                    const order = ["basic","plus","ai_fan"];
                    return order.indexOf(c.packageKey) > order.indexOf(status.currentPackageKey);
                  }).map((c) => (
                    <Button
                      key={c.packageKey}
                      variant="secondary"
                      onClick={() => { setUpgradeTarget(c.packageKey); setUpgradeState("confirm"); }}
                    >
                      {pkgLabel(c.packageKey)} — {formatVnd(c.annualPriceVnd)}/năm
                    </Button>
                  ))}
                  {pkg.canRenew && (
                    <Button
                      variant="primary"
                      onClick={() => { setUpgradeTarget(status.currentPackageKey); setUpgradeState("confirm"); }}
                    >
                      Gia hạn {pkgLabel(status.currentPackageKey)} — {formatVnd(status.annualPriceVnd)}/năm
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}
