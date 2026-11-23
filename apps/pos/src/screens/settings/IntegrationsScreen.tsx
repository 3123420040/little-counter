import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PaginatedListFrame, loadedListPaginationMeta, OperationalTable, PageHeader, Panel, ScreenState, StatusPill, TableSkeleton } from "@medusa-snus/ui";
import { fetchOwnerIntegrations, type IntegrationStatusDto } from "../../api/settings-endpoints";
import { useSettingsOwner } from "./useSettingsOwner";

const STATUS_TONE: Record<string, "success" | "danger" | "warning" | "info"> = {
  active: "success", error: "danger", inactive: "warning", pending_config: "info",
};
const STATUS_LABEL: Record<string, string> = {
  active: "Hoạt động", error: "Lỗi", inactive: "Tắt", pending_config: "Chờ cấu hình",
};

export default function IntegrationsScreen() {
  const { merchantId, isOwner } = useSettingsOwner();
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["integrations", merchantId],
    queryFn: () => fetchOwnerIntegrations(merchantId!),
    enabled: !!merchantId && isOwner,
  });
  const integrations = query.data?.data || [];
  const pageMeta = loadedListPaginationMeta(integrations.length, page, 20);
  const visibleIntegrations = integrations.slice((pageMeta.page - 1) * 20, pageMeta.page * 20);
  useEffect(() => setPage(1), [merchantId]);

  if (!isOwner) return <div className="p-4"><PageHeader title="Tích hợp" /><ScreenState state="error" title="Không có quyền" /></div>;

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Tích hợp"
        subtitle="Trạng thái và cấu hình tích hợp dịch vụ bên ngoài. Quản trị viên nền tảng quản lý khóa bí mật."
      />
      <Panel title="Trạng thái tích hợp">
        {query.isLoading ? (
          <TableSkeleton rows={5} cols={5} />
        ) : query.error ? (
          <div className="p-4">
            <ScreenState state="error" title="Không thể tải tích hợp" actionLabel="Thử lại" onAction={() => query.refetch()} />
          </div>
        ) : !integrations.length ? (
          <div className="p-4">
            <ScreenState state="empty" title="Chưa có tích hợp nào được cấu hình" body="Liên hệ quản trị viên nền tảng để kích hoạt tích hợp." />
          </div>
        ) : (
          <>
          <PaginatedListFrame
            label="Phân trang tích hợp"
            rowNoun="tích hợp"
            meta={pageMeta}
            onPageChange={setPage}
          >
            <OperationalTable
              ariaLabel="Danh sách tích hợp"
              columns={[
                { key: "provider", label: "Dịch vụ" },
                { key: "purpose", label: "Mục đích" },
                { key: "scope", label: "Phạm vi" },
                { key: "status", label: "Trạng thái" },
                { key: "health", label: "Kiểm tra sức khỏe" },
                { key: "callback", label: "Callback URL" },
                { key: "action", label: "Hành động cần thiết" },
              ]}
              rows={visibleIntegrations.map((item: IntegrationStatusDto) => ({
                provider: (
                  <span className="font-medium text-text-primary break-words">{item.providerKey}</span>
                ),
                purpose: <span className="break-words text-sm text-text-secondary">{item.purpose}</span>,
                scope: (
                  <StatusPill tone="info" label={item.scope === "merchant" ? "Merchant" : "Cửa hàng"} />
                ),
                status: (
                  <StatusPill
                    tone={STATUS_TONE[item.status] || "info"}
                    label={STATUS_LABEL[item.status] || item.status}
                  />
                ),
                health: (
                  <span className="break-words text-sm text-text-muted">{item.healthSummary || "—"}</span>
                ),
                callback: item.callbackUrl ? (
                  <span className="font-mono text-xs text-text-secondary break-all">
                    {item.callbackUrl}
                  </span>
                ) : (
                  <span className="text-text-muted">—</span>
                ),
                action: item.requiredAction ? (
                  <StatusPill tone="warning" label={item.requiredAction} />
                ) : (
                  <span className="text-text-muted">—</span>
                ),
              }))}
            />
          </PaginatedListFrame>
          </>
        )}
      </Panel>
      <div className="rounded-lg border border-border-default bg-surface-subtle p-3 text-sm text-text-muted">
        Khóa bí mật và thông tin kết nối nhạy cảm không được hiển thị tại đây. Liên hệ quản trị viên nền tảng để thay đổi cấu hình.
      </div>
    </div>
  );
}
