import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ConfirmDialog, PaginatedListFrame, loadedListPaginationMeta, OperationalTable, PageHeader, Panel, ScreenState, StatusPill, TableSkeleton } from "@medusa-snus/ui";
import {
  fetchPlatformMemberships,
  fetchPlatformMerchants,
  fetchMerchantCheckoutPolicy,
  updateMerchantCheckoutPolicy,
  fetchPlatformStores,
  grantPlatformMembership,
  revokePlatformMembership,
  type PlatformMembershipDto,
} from "../../api/settings-endpoints";
import { SelectField, TextArea, TextField } from "../settings/FormField";
import {
  localMembershipDateTimeValue,
  membershipDateTimeToIso,
  platformMembershipRevokeReasonError,
  PLATFORM_MEMBERSHIP_STATUS_LABEL,
  PLATFORM_MEMBERSHIP_STATUS_TONE,
  platformMembershipValidityErrors,
  platformMembershipValidityLabel,
} from "./platform-membership-state";
import { usePlatformAdmin } from "./usePlatformAdmin";
import { PlatformCreateMerchantPanel } from "./PlatformCreateMerchantPanel";
import { Link } from "react-router-dom";
import { PlatformEntityStatus,PlatformEntityStatusFilter } from "./PlatformEntityStatus";
import type { PlatformEntityStatusFilter as LifecycleFilter } from "../../api/settings-endpoints";

function packageLabel(key: string) {
  return key === "basic" ? "Basic" : key === "plus" ? "Plus" : "AI Fan";
}

type MembershipForm = {
  operatorId: string;
  scopeType: "platform" | "merchant" | "store";
  merchantId: string;
  storeId: string;
  roleKey: string;
  validFrom: string;
  validTo: string;
};

function emptyMembershipForm(now = new Date()): MembershipForm {
  return {
    operatorId: "",
    scopeType: "merchant",
    merchantId: "",
    storeId: "",
    roleKey: "staff",
    validFrom: localMembershipDateTimeValue(now),
    validTo: "",
  };
}

const MERCHANT_ROLES = ["owner", "manager", "staff", "accountant"] as const;
const PLATFORM_ROLES = ["platform_admin", "platform_readonly"] as const;

function membershipTarget(membership: PlatformMembershipDto): string {
  if (membership.scopeType === "platform") return "Toàn platform";
  if (membership.scopeType === "store") return `${membership.merchantName || membership.merchantId} / ${membership.storeName || membership.storeId}`;
  return membership.merchantName || membership.merchantId || "Merchant";
}

export default function PlatformMerchantsScreen() {
  const { operator, isPlatformAdmin, canWritePlatform } = usePlatformAdmin();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<MembershipForm>(() => emptyMembershipForm());
  const [grantReviewOpen, setGrantReviewOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PlatformMembershipDto | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [merchantPage, setMerchantPage] = useState(1);
  const [lifecycleFilter,setLifecycleFilter]=useState<LifecycleFilter>("all");
  const directoryQuery=useQuery({queryKey:["platformMerchants","directory",lifecycleFilter],
    queryFn:()=>fetchPlatformMerchants(lifecycleFilter),enabled:isPlatformAdmin});
  const [policyTarget, setPolicyTarget] = useState<{ merchantId: string; displayName: string } | null>(null);
  const policyQuery = useQuery({
    queryKey: ["merchantCheckoutPolicy", policyTarget?.merchantId],
    queryFn: () => fetchMerchantCheckoutPolicy(policyTarget!.merchantId),
    enabled: isPlatformAdmin && Boolean(policyTarget),
  });
  const policyMutation = useMutation({
    mutationFn: () => updateMerchantCheckoutPolicy(policyTarget!.merchantId,
      !policyQuery.data!.data.enabled, policyQuery.data!.data.version),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["merchantCheckoutPolicy"] });
      queryClient.invalidateQueries({ queryKey: ["checkoutBankSettlementPolicy"] });
      setPolicyTarget(null);
    },
    onError: () => { void policyQuery.refetch(); },
  });
  const [membershipPage, setMembershipPage] = useState(1);
  const merchantsQuery = useQuery({
    queryKey: ["platformMerchants"],
    queryFn: ()=>fetchPlatformMerchants(),
    enabled: isPlatformAdmin,
  });
  const storesQuery = useQuery({
    queryKey: ["platformStores"],
    queryFn: () => fetchPlatformStores(),
    enabled: isPlatformAdmin,
  });
  const membershipsQuery = useQuery({
    queryKey: ["platformMemberships"],
    queryFn: fetchPlatformMemberships,
    enabled: isPlatformAdmin,
  });
  const merchants = directoryQuery.data?.data || [];
  const memberships = membershipsQuery.data?.data || [];
  const merchantPageMeta = loadedListPaginationMeta(merchants.length, merchantPage, 20);
  const visibleMerchants = merchants.slice((merchantPageMeta.page - 1) * 20, merchantPageMeta.page * 20);
  const membershipPageMeta = loadedListPaginationMeta(memberships.length, membershipPage, 20);
  const visibleMemberships = memberships.slice((membershipPageMeta.page - 1) * 20, membershipPageMeta.page * 20);

  useEffect(() => {
    setMerchantPage(1);
    setMembershipPage(1);
  }, [isPlatformAdmin]);

  useEffect(() => {
    const firstMerchantId = merchantsQuery.data?.data[0]?.merchantId;
    if (firstMerchantId && !form.merchantId && form.scopeType !== "platform") {
      setForm((current) => ({ ...current, merchantId: firstMerchantId }));
    }
  }, [form.merchantId, form.scopeType, merchantsQuery.data]);

  const storeOptions = useMemo(
    () => (storesQuery.data?.data || []).filter((store) => store.merchantId === form.merchantId),
    [form.merchantId, storesQuery.data],
  );
  useEffect(() => {
    if (form.scopeType !== "store") return;
    if (storeOptions.some((store) => store.storeId === form.storeId)) return;
    setForm((current) => ({ ...current, storeId: storeOptions[0]?.storeId || "" }));
  }, [form.scopeType, form.storeId, storeOptions]);

  const errors = useMemo(() => ({
    operatorId: form.operatorId.trim() ? undefined : "Nhập tên đăng nhập / username đã tồn tại.",
    merchantId: form.scopeType === "platform" || form.merchantId ? undefined : "Chọn merchant.",
    storeId: form.scopeType !== "store" || form.storeId ? undefined : "Chọn cửa hàng.",
    ...platformMembershipValidityErrors(form.validFrom, form.validTo),
  }), [form]);
  const hasErrors = Object.values(errors).some(Boolean);
  const revokeReasonError = platformMembershipRevokeReasonError(revokeReason);
  const grantMutation = useMutation({
    mutationFn: () => grantPlatformMembership({
      operatorId: form.operatorId.trim(),
      scopeType: form.scopeType,
      roleKey: form.roleKey,
      ...(form.scopeType === "platform" ? {} : { merchantId: form.merchantId }),
      ...(form.scopeType === "store" ? { storeId: form.storeId } : {}),
      validFrom: membershipDateTimeToIso(form.validFrom),
      validTo: form.validTo ? membershipDateTimeToIso(form.validTo) : null,
    }),
    onSuccess: () => {
      setGrantReviewOpen(false);
      setForm((current) => ({ ...current, operatorId: "", validFrom: localMembershipDateTimeValue(), validTo: "" }));
      queryClient.invalidateQueries({ queryKey: ["platformMemberships"] });
      queryClient.invalidateQueries({ queryKey: ["platformMerchants"] });
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const revokeMutation = useMutation({
    mutationFn: ({ membershipId, reason }: { membershipId: string; reason: string }) => revokePlatformMembership(membershipId, { reason }),
    onSuccess: () => {
      setRevokeTarget(null);
      setRevokeReason("");
      queryClient.invalidateQueries({ queryKey: ["platformMemberships"] });
      queryClient.invalidateQueries({ queryKey: ["platformMerchants"] });
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });

  if (!isPlatformAdmin) {
    return <div className="p-4"><PageHeader title="Merchants" /><ScreenState state="error" title="Không có quyền" body="Cần quyền platform admin." /></div>;
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Merchants & phân quyền"
        subtitle="Xem tenant và cấp/thu hồi membership theo platform, merchant hoặc store."
        status={canWritePlatform ? <StatusPill tone="info" label="Có quyền chỉnh sửa" /> : <StatusPill tone="neutral" label="Chỉ đọc" />}
      />

      <PlatformCreateMerchantPanel key={operator?.id} />

      <Panel title="Danh sách merchants">
        <PlatformEntityStatusFilter value={lifecycleFilter} onChange={value=>{setLifecycleFilter(value);setMerchantPage(1);}}/>
        {directoryQuery.isLoading ? <TableSkeleton rows={6} cols={6} /> : directoryQuery.error ? (
          <div className="p-4"><ScreenState state="error" title="Không thể tải" actionLabel="Thử lại" onAction={() => directoryQuery.refetch()} /></div>
        ) : !directoryQuery.data?.data.length ? (
          <div className="p-4"><ScreenState state="empty" title="Chưa có merchant" /></div>
        ) : (
          <div>
          <PaginatedListFrame
            label="Phân trang merchant"
            rowNoun="merchant"
            meta={merchantPageMeta}
            onPageChange={setMerchantPage}
          >
            <OperationalTable
              ariaLabel="Merchants"
              columns={[
                { key: "name", label: "Tên" },
                { key: "pkg", label: "Gói" },
                { key: "lifecycle", label: "Hoạt động" },
                { key: "status", label: "Gói dịch vụ" },
                { key: "stores", label: "Cửa hàng" },
                { key: "owners", label: "Owner" },
                { key: "created", label: "Tạo lúc" },
                { key: "foundStock", label: "Tìm thấy hàng" },
              ]}
              rows={visibleMerchants.map((merchant) => ({
                name: (
                  <Link className="font-medium text-primary underline break-words" to={`/platform/merchants/${encodeURIComponent(merchant.merchantId)}`}>{merchant.displayName}</Link>
                ),
                lifecycle:<PlatformEntityStatus status={merchant.status}/>,
                pkg: <StatusPill tone="info" label={packageLabel(merchant.packageKey)} />,
                status: (
                  <StatusPill
                    tone={
                      merchant.subscriptionStatus === "active"
                        ? "success"
                        : merchant.subscriptionStatus === "grace"
                          ? "warning"
                          : "danger"
                    }
                    label={merchant.subscriptionStatus}
                  />
                ),
                stores: <span className="tabular-nums">{merchant.storeCount}</span>,
                owners: <span className="tabular-nums">{merchant.ownerCount}</span>,
                foundStock: <Button variant="secondary" disabled={merchant.status!=="active"} onClick={() => {
                  policyMutation.reset(); setPolicyTarget(merchant);
                }}>Xem cấu hình</Button>,
                created: (
                  <span className="text-xs text-text-muted">
                    {new Date(merchant.createdAt).toLocaleDateString("vi-VN")}
                  </span>
                ),
              }))}
            />
          </PaginatedListFrame>
          </div>
        )}
      </Panel>

      <div className={canWritePlatform ? "grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(340px,0.7fr)]" : ""}>
        <Panel title="Membership theo hiệu lực">
          {membershipsQuery.isLoading ? <TableSkeleton rows={6} cols={5} /> : membershipsQuery.error ? (
            <div className="p-4"><ScreenState state="error" title="Không thể tải membership" actionLabel="Thử lại" onAction={() => membershipsQuery.refetch()} /></div>
          ) : !membershipsQuery.data?.data.length ? (
            <div className="p-4"><ScreenState state="empty" title="Chưa có membership" /></div>
          ) : (
            <div>
            <PaginatedListFrame
              label="Phân trang membership"
              rowNoun="membership"
              meta={membershipPageMeta}
              onPageChange={setMembershipPage}
            >
              <OperationalTable
                ariaLabel="Membership platform"
                columns={[
                  { key: "operator", label: "Operator" },
                  { key: "role", label: "Vai trò" },
                  { key: "target", label: "Phạm vi" },
                  { key: "status", label: "Trạng thái" },
                  { key: "validity", label: "Thời hạn" },
                  ...(canWritePlatform ? [{ key: "action", label: "" }] : []),
                ]}
                rows={visibleMemberships.map((membership) => ({
                  operator: (
                    <div>
                      <p className="font-medium break-words">
                        {membership.displayName || membership.operatorId}
                      </p>
                      <p className="font-mono text-xs text-text-muted break-all">{membership.operatorId}</p>
                    </div>
                  ),
                  role: (
                    <StatusPill
                      tone={
                        membership.roleKey === "platform_admin" || membership.roleKey === "owner"
                          ? "info"
                          : "neutral"
                      }
                      label={membership.roleKey}
                    />
                  ),
                  target: <span className="break-words">{membershipTarget(membership)}</span>,
                  status: (
                    <StatusPill
                      tone={PLATFORM_MEMBERSHIP_STATUS_TONE[membership.effectiveStatus]}
                      label={PLATFORM_MEMBERSHIP_STATUS_LABEL[membership.effectiveStatus]}
                    />
                  ),
                  validity: (
                    <span className="text-xs text-text-muted">
                      {platformMembershipValidityLabel(membership)} · Cấp bởi {membership.grantedBy}
                    </span>
                  ),
                  ...(canWritePlatform
                    ? {
                        action: (
                          <Button size="sm" variant="danger" onClick={() => setRevokeTarget(membership)}>
                            Thu hồi
                          </Button>
                        ),
                      }
                    : {}),
                }))}
              />
            </PaginatedListFrame>
            </div>
          )}
        </Panel>

        {canWritePlatform && (
          <Panel title="Cấp membership">
            <div className="space-y-3 p-4">
              <TextField
                label="Tên đăng nhập / Username"
                required
                value={form.operatorId}
                error={errors.operatorId}
                hint="Username phải thuộc một tài khoản đang hoạt động."
                disabled={grantMutation.isPending}
                onChange={(event) => setForm((current) => ({ ...current, operatorId: event.target.value }))}
              />
              <SelectField
                label="Loại phạm vi"
                value={form.scopeType}
                disabled={grantMutation.isPending}
                onChange={(event) => {
                  const scopeType = event.target.value as MembershipForm["scopeType"];
                  setForm((current) => ({
                    ...current,
                    scopeType,
                    merchantId: scopeType === "platform" ? "" : current.merchantId,
                    storeId: scopeType === "store" ? current.storeId : "",
                    roleKey: scopeType === "platform" ? "platform_readonly" : "staff",
                  }));
                }}
              >
                <option value="platform">Platform</option>
                <option value="merchant">Merchant</option>
                <option value="store">Cửa hàng</option>
              </SelectField>
              <TextField
                label="Bắt đầu hiệu lực"
                type="datetime-local"
                required
                value={form.validFrom}
                error={errors.validFrom}
                disabled={grantMutation.isPending}
                onChange={(event) => setForm((current) => ({ ...current, validFrom: event.target.value }))}
              />
              <TextField
                label="Kết thúc hiệu lực"
                type="datetime-local"
                value={form.validTo}
                error={errors.validTo}
                disabled={grantMutation.isPending}
                onChange={(event) => setForm((current) => ({ ...current, validTo: event.target.value }))}
              />
              {form.scopeType !== "platform" && (
                <SelectField
                  label="Merchant"
                  required
                  value={form.merchantId}
                  error={errors.merchantId}
                  disabled={grantMutation.isPending}
                  onChange={(event) => setForm((current) => ({ ...current, merchantId: event.target.value, storeId: "" }))}
                >
                  <option value="">Chọn merchant</option>
                  {(merchantsQuery.data?.data || []).map((merchant) => (
                    <option key={merchant.merchantId} value={merchant.merchantId}>{merchant.displayName}</option>
                  ))}
                </SelectField>
              )}
              {form.scopeType === "store" && (
                <SelectField
                  label="Cửa hàng"
                  required
                  value={form.storeId}
                  error={errors.storeId}
                  disabled={grantMutation.isPending || !form.merchantId}
                  onChange={(event) => setForm((current) => ({ ...current, storeId: event.target.value }))}
                >
                  <option value="">Chọn cửa hàng</option>
                  {storeOptions.map((store) => <option key={store.storeId} value={store.storeId}>{store.internalName}</option>)}
                </SelectField>
              )}
              <SelectField
                label="Vai trò"
                value={form.roleKey}
                disabled={grantMutation.isPending}
                onChange={(event) => setForm((current) => ({ ...current, roleKey: event.target.value }))}
              >
                {(form.scopeType === "platform" ? PLATFORM_ROLES : MERCHANT_ROLES).map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </SelectField>
              {grantMutation.error && <ScreenState state="error" title="Không thể cấp membership" body={grantMutation.error instanceof Error ? grantMutation.error.message : "Lỗi không xác định"} />}
              {grantMutation.isSuccess && <StatusPill tone="success" label="Đã cấp membership" />}
              <Button variant="primary" className="w-full" disabled={hasErrors || grantMutation.isPending} onClick={() => setGrantReviewOpen(true)}>
                {grantMutation.isPending ? "Đang cấp..." : "Xem lại và cấp"}
              </Button>
            </div>
          </Panel>
        )}
      </div>

      <ConfirmDialog
        open={grantReviewOpen}
        title="Xác nhận cấp membership"
        message={`${form.operatorId.trim()} sẽ nhận quyền ${form.roleKey} từ ${new Date(form.validFrom).toLocaleString("vi-VN")}${form.validTo ? ` đến ${new Date(form.validTo).toLocaleString("vi-VN")}` : " đến khi thu hồi"}.`}
        confirmLabel="Xác nhận cấp"
        pending={grantMutation.isPending}
        onConfirm={() => grantMutation.mutate()}
        onCancel={() => setGrantReviewOpen(false)}
      />

      <ConfirmDialog
        open={Boolean(policyTarget)}
        title={`Tìm thấy hàng — ${policyTarget?.displayName || ""}`}
        message="Cho phép nhân viên xác nhận đã tìm thấy hàng còn thiếu để bổ sung tồn và bán đơn. Tắt cấu hình vẫn cho bán hàng có đủ tồn."
        confirmLabel={policyQuery.data?.data.enabled ? "Tắt cho merchant này" : "Bật cho merchant này"}
        pending={policyMutation.isPending}
        confirmDisabled={!canWritePlatform || !policyQuery.data || policyQuery.isFetching || policyQuery.isError}
        onConfirm={() => policyMutation.mutate()}
        onCancel={() => { if (!policyMutation.isPending) setPolicyTarget(null); }}
      >
        {policyQuery.isPending ? <p>Đang tải cấu hình...</p> : policyQuery.isError ? (
          <ScreenState state="error" title="Không thể tải cấu hình" actionLabel="Thử lại" onAction={() => policyQuery.refetch()} />
        ) : <p>{policyQuery.data?.data.status === "invalid" ? "Cấu hình không hợp lệ: chức năng đang bị khóa." :
          `${policyQuery.data?.data.enabled ? "Đang bật" : "Đang tắt"}${policyQuery.data?.data.source === "default" ? " (mặc định)" : ""}.`}</p>}
        {policyMutation.error && <ScreenState state="error" title="Chưa lưu cấu hình" body={policyMutation.error instanceof Error ? policyMutation.error.message : "Thử lại sau khi tải cấu hình mới."} />}
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title="Thu hồi membership?"
        message={revokeTarget ? `${revokeTarget.displayName || revokeTarget.operatorId} sẽ mất quyền ${revokeTarget.roleKey} trên ${membershipTarget(revokeTarget)}. Dữ liệu membership được giữ lại để audit.` : undefined}
        confirmLabel="Thu hồi"
        danger
        pending={revokeMutation.isPending}
        confirmDisabled={Boolean(revokeReasonError)}
        onConfirm={() => revokeTarget && revokeMutation.mutate({ membershipId: revokeTarget.membershipId, reason: revokeReason.trim() })}
        onCancel={() => { setRevokeTarget(null); setRevokeReason(""); }}
      >
        <TextArea
          label="Lý do thu hồi"
          required
          rows={4}
          maxLength={500}
          value={revokeReason}
          error={revokeReasonError}
          disabled={revokeMutation.isPending}
          onChange={(event) => setRevokeReason(event.target.value)}
        />
      </ConfirmDialog>
    </div>
  );
}
