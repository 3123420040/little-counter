import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PaginatedListFrame, loadedListPaginationMeta, OperationalTable, PageHeader, Panel, ScreenState, StatusPill, TableSkeleton } from "@medusa-snus/ui";
import { fetchSignupIdentities } from "../../api/settings-endpoints";
import { usePlatformAdmin } from "./usePlatformAdmin";

const STATUS_TONE: Record<string, "warning" | "success" | "danger" | "info"> = { pending_verification: "warning", verified: "success", suspended: "danger" };
const STATUS_LABEL: Record<string, string> = { pending_verification: "Chờ xác minh", verified: "Đã xác minh", suspended: "Tạm khóa" };

export default function PlatformSignupIdentityScreen() {
  const { isPlatformAdmin } = usePlatformAdmin();
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ["signupIdentities"], queryFn: fetchSignupIdentities, enabled: isPlatformAdmin });
  const identities = query.data?.data || [];
  const pageMeta = loadedListPaginationMeta(identities.length, page, 20);
  const visibleIdentities = identities.slice((pageMeta.page - 1) * 20, pageMeta.page * 20);
  useEffect(() => setPage(1), [isPlatformAdmin]);
  if (!isPlatformAdmin) return <div className="p-4"><PageHeader title="Đăng ký" /><ScreenState state="error" title="Không có quyền" /></div>;
  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Danh tính đăng ký" subtitle="Các đăng ký công khai và trạng thái xác minh." />
      <Panel title="Danh sách">
        {query.isLoading ? <TableSkeleton rows={6} cols={5} /> : query.error ? <div className="p-4"><ScreenState state="error" title="Không thể tải" actionLabel="Thử lại" onAction={() => query.refetch()} /></div> : !query.data?.data.length ? <div className="p-4"><ScreenState state="empty" title="Chưa có đăng ký" /></div> : (
          <div>
          <PaginatedListFrame
            label="Phân trang đăng ký"
            rowNoun="đăng ký"
            meta={pageMeta}
            onPageChange={setPage}
          >
            <OperationalTable
              ariaLabel="Đăng ký"
              columns={[
                { key: "email", label: "Email" },
                { key: "status", label: "Trạng thái" },
                { key: "merchant", label: "Merchant" },
                { key: "created", label: "Đăng ký lúc" },
                { key: "verified", label: "Xác minh lúc" },
              ]}
              rows={visibleIdentities.map((i) => ({
                email: <span className="break-words">{i.email}</span>,
                status: (
                  <StatusPill
                    tone={STATUS_TONE[i.status] || "info"}
                    label={STATUS_LABEL[i.status] || i.status}
                  />
                ),
                merchant: i.merchantName ? (
                  <span className="break-words">{i.merchantName}</span>
                ) : (
                  <span className="text-text-muted">—</span>
                ),
                created: (
                  <span className="text-xs text-text-muted">
                    {new Date(i.createdAt).toLocaleString("vi-VN")}
                  </span>
                ),
                verified: i.verifiedAt ? (
                  <span className="text-xs text-text-muted">
                    {new Date(i.verifiedAt).toLocaleString("vi-VN")}
                  </span>
                ) : (
                  <span className="text-text-muted">—</span>
                ),
              }))}
            />
          </PaginatedListFrame>
          </div>
        )}
      </Panel>
    </div>
  );
}
