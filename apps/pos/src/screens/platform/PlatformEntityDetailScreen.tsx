import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  Button,
  PageHeader,
  Panel,
  ScreenState,
  StatusPill,
} from "@medusa-snus/ui";
import {
  fetchPlatformMerchantDetail,
  fetchPlatformStoreDetail,
  type PlatformLifecycleAuditDto,
  type PlatformMerchantDetailDto,
  type PlatformStoreDetailDto,
} from "../../api/settings-endpoints";
import { usePlatformAdmin } from "./usePlatformAdmin";
import { PlatformEntityStatus } from "./PlatformEntityStatus";
import { PlatformLifecycleControl } from "./PlatformLifecycleControl";
import { PlatformMerchantMcpSection } from "./PlatformMerchantMcpSection";

function LifecycleHistory({
  page,
  pending,
  onPage,
}: {
  page: PlatformLifecycleAuditDto;
  pending: boolean;
  onPage: (offset: number) => void;
}) {
  return (
    <Panel title="Lịch sử hoạt động">
      <div className="space-y-3 p-4">
        {page.data.length === 0 ? (
          <p className="text-sm text-text-secondary">
            Chưa có thay đổi trạng thái.
          </p>
        ) : (
          <ol className="space-y-3">
            {page.data.map((event) => (
              <li
                key={event.id}
                className="rounded-xl border border-border p-3 text-sm"
              >
                <p className="font-medium">{event.action}</p>
                <p className="break-words">
                  {event.actorId} ·{" "}
                  {new Date(event.createdAt).toLocaleString("vi-VN")}
                </p>
                <div className="my-2 flex flex-wrap items-center gap-2">
                  {event.beforeStatus && (
                    <PlatformEntityStatus status={event.beforeStatus} />
                  )}
                  <span aria-hidden="true">→</span>
                  {event.afterStatus && (
                    <PlatformEntityStatus status={event.afterStatus} />
                  )}
                </div>
                {event.reason && (
                  <p className="whitespace-pre-wrap break-words">
                    {event.reason}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
        <nav
          className="flex items-center gap-3"
          aria-label="Phân trang lịch sử hoạt động"
        >
          <Button
            variant="secondary"
            disabled={pending || page.offset === 0}
            onClick={() => onPage(Math.max(0, page.offset - page.limit))}
          >
            Trang trước
          </Button>
          <span className="text-sm">
            Trang {Math.floor(page.offset / page.limit) + 1}
          </span>
          <Button
            variant="secondary"
            disabled={pending || !page.hasMore}
            onClick={() => onPage(page.offset + page.limit)}
          >
            Trang sau
          </Button>
        </nav>
      </div>
    </Panel>
  );
}

function MerchantSections({
  merchant,
}: {
  merchant: PlatformMerchantDetailDto;
}) {
  return (
    <>
      <Panel title="Gói dịch vụ và cấu hình bán hàng">
        <dl className="grid gap-3 p-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-text-muted">Gói</dt>
            <dd>{merchant.packageKey}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Trạng thái gói dịch vụ</dt>
            <dd>{merchant.subscriptionStatus}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Tìm thấy hàng khi hết tồn</dt>
            <dd>
              {merchant.checkoutPolicy.status !== "ok"
                ? "Cấu hình cần kiểm tra"
                : merchant.checkoutPolicy.enabled
                  ? "Bật"
                  : "Tắt"}
            </dd>
          </div>
        </dl>
      </Panel>
      <Panel title="Owner đang có hiệu lực">
        <ul className="space-y-2 p-4 text-sm">
          {merchant.owners.length === 0 ? (
            <li>Chưa có owner đang có hiệu lực.</li>
          ) : (
            merchant.owners.map((owner) => (
              <li key={owner.membershipId} className="break-words">
                <span className="font-medium">{owner.displayName}</span> ·{" "}
                {owner.operatorId}
                {owner.storeId
                  ? ` · Cửa hàng ${owner.storeId}`
                  : " · Toàn merchant"}
              </li>
            ))
          )}
        </ul>
      </Panel>
      <Panel title="Cửa hàng">
        <ul className="space-y-3 p-4">
          {merchant.stores.length === 0 ? (
            <li className="text-sm">Chưa có cửa hàng.</li>
          ) : (
            merchant.stores.map((store) => (
              <li
                key={store.storeId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3"
              >
                <Link
                  className="font-medium text-primary underline break-words"
                  to={`/platform/stores/${encodeURIComponent(store.storeId)}`}
                >
                  {store.internalName}
                </Link>
                <div className="flex flex-wrap gap-2">
                  {store.isPrimary && <StatusPill tone="info" label="Chính" />}
                  <PlatformEntityStatus status={store.effectiveStatus} />
                </div>
              </li>
            ))
          )}
        </ul>
      </Panel>
    </>
  );
}

export default function PlatformEntityDetailScreen({
  kind,
}: {
  kind: "merchant" | "store";
}) {
  const { merchantId, storeId } = useParams();
  const id = kind === "merchant" ? merchantId : storeId;
  const { operator, isPlatformAdmin, canManageMerchantLifecycle } = usePlatformAdmin();
  const queryClient = useQueryClient();
  const [auditOffset, setAuditOffset] = useState(0);
  const [commandRevision, setCommandRevision] = useState(0);
  useEffect(() => setAuditOffset(0), [id, kind, operator?.id]);
  const detail = useQuery<{
    data: PlatformMerchantDetailDto | PlatformStoreDetailDto;
  }>({
    queryKey: ["platformEntityDetail", operator?.id, kind, id, auditOffset],
    queryFn: () =>
      kind === "merchant"
        ? fetchPlatformMerchantDetail(id!, auditOffset)
        : fetchPlatformStoreDetail(id!, auditOffset),
    enabled: isPlatformAdmin && Boolean(id),
  });
  if (!isPlatformAdmin)
    return (
      <div className="p-4">
        <ScreenState
          state="error"
          title="Không có quyền"
          body="Cần quyền đọc platform."
        />
      </div>
    );
  if (!id)
    return (
      <div className="p-4">
        <ScreenState state="error" title="Thiếu mã đối tượng" />
      </div>
    );
  if (detail.isPending)
    return (
      <div className="p-4">
        <ScreenState state="loading" title="Đang tải chi tiết" />
      </div>
    );
  if (detail.isError)
    return (
      <div className="p-4">
        <ScreenState
          state="error"
          title="Không thể tải chi tiết"
          body="Đối tượng không tồn tại hoặc bạn không có quyền xem."
          actionLabel="Thử lại"
          onAction={() => detail.refetch()}
        />
      </div>
    );
  const data = detail.data.data,
    merchant = "owners" in data ? data : null;
  return (
    <div className="space-y-4 p-4">
      <Link
        className="text-primary underline"
        to={kind === "merchant" ? "/platform/merchants" : "/platform/stores"}
      >
        ← Danh sách {kind === "merchant" ? "merchant" : "cửa hàng"}
      </Link>
      <PageHeader
        title={
          merchant
            ? merchant.displayName
            : "internalName" in data
              ? data.internalName
              : "Cửa hàng"
        }
        subtitle={`${kind === "merchant" ? "Merchant" : "Cửa hàng"}: ${id}`}
        status={<PlatformEntityStatus status={data.status} />}
      />
      <Panel title="Thông tin hoạt động">
        <dl className="grid gap-3 p-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-text-muted">Trạng thái riêng</dt>
            <dd>
              <PlatformEntityStatus status={data.status} />
            </dd>
          </div>
          <div>
            <dt className="text-text-muted">Phiên bản trạng thái</dt>
            <dd>{data.statusVersion}</dd>
          </div>
          {"effectiveStatus" in data && (
            <>
              <div>
                <dt className="text-text-muted">Trạng thái hiệu lực</dt>
                <dd>
                  <PlatformEntityStatus status={data.effectiveStatus} />
                </dd>
              </div>
              <div>
                <dt className="text-text-muted">Merchant</dt>
                <dd>
                  <Link
                    className="text-primary underline break-words"
                    to={`/platform/merchants/${encodeURIComponent(data.merchantId)}`}
                  >
                    {data.merchantName}
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="text-text-muted">Vị trí kho</dt>
                <dd className="break-all">{data.stockLocationId}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Cửa hàng chính</dt>
                <dd>{data.isPrimary ? "Có" : "Không"}</dd>
              </div>
            </>
          )}
          <div>
            <dt className="text-text-muted">Ngày tạo</dt>
            <dd>{new Date(data.createdAt).toLocaleString("vi-VN")}</dd>
          </div>
        </dl>
      </Panel>
      {canManageMerchantLifecycle && <Panel title="Thay đổi hoạt động">
        <PlatformLifecycleControl key={`${operator?.id}:${kind}:${id}:${data.statusVersion}:${commandRevision}`} kind={kind} id={id}
          name={merchant ? merchant.displayName : "internalName" in data ? data.internalName : id}
          status={data.status} version={data.statusVersion} parentStatus={"merchantStatus" in data ? data.merchantStatus : undefined}
          onChanged={async () => {
            setAuditOffset(0);
            await Promise.all(["platformEntityDetail", "platformMerchants", "platformStores", "me"].map(key =>
              queryClient.invalidateQueries({ queryKey: [key] })));
            setCommandRevision(revision => revision + 1);
          }} />
      </Panel>}
      {merchant && <MerchantSections merchant={merchant} />}
      {merchant && <PlatformMerchantMcpSection merchant={merchant} />}
      <LifecycleHistory
        page={data.lifecycleAudit}
        pending={detail.isFetching}
        onPage={setAuditOffset}
      />
    </div>
  );
}
