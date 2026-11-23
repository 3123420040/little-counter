import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ConfirmDialog, PaginatedListFrame, loadedListPaginationMeta, MutationBanner, OperationalTable, PageHeader, Panel, ScreenState, StatusPill, TableSkeleton } from "@medusa-snus/ui";
import { Copy, KeyRound, ShieldPlus, ShieldX, UserX, UserCheck } from "lucide-react";
import {
  fetchPlatformOperators,
  grantPlatformOperatorPermission,
  resetPlatformOperatorPassword,
  revokePlatformOperatorPermission,
  startPlatformImpersonation,
  suspendPlatformOperator,
  unsuspendPlatformOperator,
  type PlatformOperatorDto,
} from "../../api/settings-endpoints";
import { getToken, setToken } from "../../api/client";
import { SelectField, TextArea, TextField } from "../settings/FormField";
import { isEffectivePlatformOperatorGrant } from "./platform-operator-grant-state";
import { usePlatformAdmin } from "./usePlatformAdmin";

const SENSITIVE_PERMISSIONS = [
  "platform_operator:read",
  "platform_operator:reset_password",
  "platform_operator:suspend",
  "platform_membership:write",
  "platform_impersonation:start",
] as const;

type SecretState = { operatorId: string; temporaryPassword: string } | null;
type ImpersonationForm = { reason: string; ticketRef: string; durationMinutes: number };

const initialImpersonationForm: ImpersonationForm = {
  reason: "",
  ticketRef: "",
  durationMinutes: 30,
};

function globalStatusLabel(status: PlatformOperatorDto["globalStatus"]) {
  return status === "suspended" ? "Tạm khóa" : "Đang hoạt động";
}

export default function PlatformOperatorsScreen() {
  const queryClient = useQueryClient();
  const {
    canReadOperators,
    canResetOperators,
    canSuspendOperators,
    canStartImpersonation,
    canWritePlatformMemberships,
  } = usePlatformAdmin();
  const [secret, setSecret] = useState<SecretState>(null);
  const [selectedOperatorId, setSelectedOperatorId] = useState<string | null>(null);
  const [impersonationTarget, setImpersonationTarget] = useState<PlatformOperatorDto | null>(null);
  const [impersonationForm, setImpersonationForm] = useState<ImpersonationForm>(initialImpersonationForm);
  const [grantPermission, setGrantPermission] = useState<string>("platform_operator:read");
  const [reason, setReason] = useState("");
  const [page, setPage] = useState(1);

  const operatorsQuery = useQuery({
    queryKey: ["platformOperators"],
    queryFn: fetchPlatformOperators,
    enabled: canReadOperators,
  });
  const rows = operatorsQuery.data?.data || [];
  const pageMeta = loadedListPaginationMeta(rows.length, page, 20);
  const visibleRows = rows.slice((pageMeta.page - 1) * 20, pageMeta.page * 20);
  const selectedOperator = selectedOperatorId
    ? rows.find((operator) => operator.operatorId === selectedOperatorId) || null
    : null;

  useEffect(() => setPage(1), [canReadOperators]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["platformOperators"] }),
      queryClient.invalidateQueries({ queryKey: ["me"] }),
    ]);
  };

  const resetMutation = useMutation({
    mutationFn: (operatorId: string) => resetPlatformOperatorPassword(operatorId, { reason: "Platform owner reset" }),
    onSuccess: async (result) => {
      setSecret(result.data);
      await invalidate();
    },
  });
  const suspendMutation = useMutation({
    mutationFn: ({ operatorId, suspended }: { operatorId: string; suspended: boolean }) => (
      suspended ? unsuspendPlatformOperator(operatorId, { reason: "Platform owner unsuspend" }) : suspendPlatformOperator(operatorId, { reason: "Platform owner suspend" })
    ),
    onSuccess: invalidate,
  });
  const grantMutation = useMutation({
    mutationFn: () => grantPlatformOperatorPermission(selectedOperator!.operatorId, {
      permissionId: grantPermission,
      reason,
    }),
    onSuccess: async () => {
      setReason("");
      await invalidate();
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (grantId: string) => revokePlatformOperatorPermission(grantId, { reason: "Platform owner revoke" }),
    onSuccess: invalidate,
  });
  const impersonationMutation = useMutation({
    mutationFn: () => {
      if (!impersonationTarget) throw new Error("No operator selected");
      return startPlatformImpersonation({
        targetOperatorId: impersonationTarget.operatorId,
        reason: impersonationForm.reason,
        ticketRef: impersonationForm.ticketRef || undefined,
        durationMinutes: impersonationForm.durationMinutes,
      });
    },
    onSuccess: async (result) => {
      const adminToken = getToken();
      if (adminToken) sessionStorage.setItem("snus_admin_token_during_impersonation", adminToken);
      setToken(result.data.token);
      await invalidate();
      window.location.assign("/pos");
    },
  });

  if (!canReadOperators) {
    return <div className="p-4"><PageHeader title="Operators" /><ScreenState state="error" title="Không có quyền" body="Cần explicit grant platform_operator:read." /></div>;
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Operators" subtitle="Quản lý bảo mật và explicit grants của operator." />
      <Panel title="Danh sách operators">
        {operatorsQuery.isLoading ? <TableSkeleton rows={6} cols={7} /> : operatorsQuery.error ? (
          <div className="p-4"><ScreenState state="error" title="Không thể tải operators" actionLabel="Thử lại" onAction={() => operatorsQuery.refetch()} /></div>
        ) : rows.length === 0 ? (
          <div className="p-4"><ScreenState state="empty" title="Chưa có operator" /></div>
        ) : (
          <div>
          <PaginatedListFrame
            label="Phân trang operator"
            rowNoun="operator"
            meta={pageMeta}
            onPageChange={setPage}
          >
            <OperationalTable
              ariaLabel="Operators"
              minWidth={1120}
              columns={[
                { key: "operator", label: "Operator" },
                { key: "status", label: "Trạng thái toàn hệ thống" },
                { key: "memberships", label: "Memberships" },
                { key: "security", label: "Bảo mật" },
                { key: "grants", label: "Sensitive grants" },
                { key: "actions", label: "Thao tác", align: "right" },
              ]}
              rows={visibleRows.map((operator) => ({
                operator: (
                  <div>
                    <div className="font-medium text-text-primary">{operator.displayName}</div>
                    <div className="font-mono text-xs text-text-muted">{operator.operatorId}</div>
                  </div>
                ),
                status: (
                  <StatusPill
                    tone={operator.globalStatus === "active" ? "success" : "danger"}
                    label={globalStatusLabel(operator.globalStatus)}
                  />
                ),
                memberships: (
                  <span className="text-xs text-text-secondary">
                    {operator.memberships.length} membership
                  </span>
                ),
                security: operator.requiresPasswordChange ? (
                  <StatusPill tone="warning" label="Cần đổi mật khẩu" />
                ) : (
                  <StatusPill tone="neutral" label={`Session v${operator.sessionVersion}`} />
                ),
                grants: (
                  <span className="text-xs text-text-secondary">
                    {
                      operator.explicitGrants.filter((grant) => isEffectivePlatformOperatorGrant(grant))
                        .length
                    }{" "}
                    grant đang hoạt động
                  </span>
                ),
                actions: (
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setSelectedOperatorId(operator.operatorId)}
                    >
                      <ShieldPlus size={14} />
                      Grants
                    </Button>
                    {canResetOperators ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => resetMutation.mutate(operator.operatorId)}
                        disabled={resetMutation.isPending}
                      >
                        <KeyRound size={14} />
                        Reset mật khẩu
                      </Button>
                    ) : null}
                    {canStartImpersonation ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setImpersonationTarget(operator);
                          setImpersonationForm(initialImpersonationForm);
                        }}
                        disabled={impersonationMutation.isPending}
                      >
                        Xem như
                      </Button>
                    ) : null}
                    {canSuspendOperators ? (
                      <Button
                        variant={operator.globalStatus === "active" ? "danger" : "secondary"}
                        size="sm"
                        onClick={() =>
                          suspendMutation.mutate({
                            operatorId: operator.operatorId,
                            suspended: operator.globalStatus === "suspended",
                          })
                        }
                        disabled={suspendMutation.isPending}
                      >
                        {operator.globalStatus === "active" ? <UserX size={14} /> : <UserCheck size={14} />}
                        {operator.globalStatus === "active" ? "Tạm khóa" : "Mở khóa"}
                      </Button>
                    ) : null}
                  </div>
                ),
              }))}
            />
          </PaginatedListFrame>
          </div>
        )}
      </Panel>

      <ConfirmDialog
        open={Boolean(impersonationTarget)}
        title={impersonationTarget ? `Bắt đầu phiên chỉ xem: ${impersonationTarget.operatorId}` : "Bắt đầu phiên chỉ xem"}
        message="Phiên này chỉ được xem. Mọi mutation sẽ bị chặn và ghi audit."
        confirmLabel="Bắt đầu chỉ xem"
        pending={impersonationMutation.isPending}
        confirmDisabled={impersonationForm.reason.trim().length < 4}
        onConfirm={() => impersonationMutation.mutate()}
        onCancel={() => setImpersonationTarget(null)}
      >
        <div className="space-y-3">
          {impersonationMutation.error ? (
            <MutationBanner tone="error" message={impersonationMutation.error instanceof Error ? impersonationMutation.error.message : "Không thể bắt đầu impersonation."} />
          ) : null}
          <TextArea
            label="Lý do"
            value={impersonationForm.reason}
            onChange={(event) => setImpersonationForm((current) => ({ ...current, reason: event.target.value }))}
            rows={3}
            required
          />
          <TextField
            label="Ticket / reference"
            value={impersonationForm.ticketRef}
            onChange={(event) => setImpersonationForm((current) => ({ ...current, ticketRef: event.target.value }))}
          />
          <TextField
            label="Thời lượng (phút)"
            type="number"
            min={5}
            max={120}
            value={String(impersonationForm.durationMinutes)}
            onChange={(event) => setImpersonationForm((current) => ({ ...current, durationMinutes: Number(event.target.value || 30) }))}
          />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(secret)}
        title="Mật khẩu tạm thời đã được tạo"
        message="Sao chép mật khẩu này ngay bây giờ. Hệ thống chỉ hiển thị một lần."
        confirmLabel="Đã lưu mật khẩu"
        onConfirm={() => setSecret(null)}
        onCancel={() => undefined}
      >
        <div className="space-y-2">
          <TextField label="Tên đăng nhập / Username" value={secret?.operatorId || ""} readOnly />
          <div className="rounded-md border border-border-default bg-surface-subtle p-3 font-mono text-sm text-text-primary break-all">
            {secret?.temporaryPassword}
          </div>
          <Button variant="secondary" size="sm" onClick={() => secret?.temporaryPassword && navigator.clipboard?.writeText(secret.temporaryPassword)}>
            <Copy size={14} />
            Sao chép
          </Button>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(selectedOperatorId && selectedOperator)}
        title={selectedOperator ? `Explicit grants: ${selectedOperator.operatorId}` : "Explicit grants"}
        confirmLabel="Cấp grant"
        pending={grantMutation.isPending}
        confirmDisabled={!canWritePlatformMemberships}
        onConfirm={() => selectedOperator && grantMutation.mutate()}
        onCancel={() => setSelectedOperatorId(null)}
      >
        <div className="space-y-4">
          {!canWritePlatformMemberships ? <MutationBanner tone="warning" message="Bạn không có platform_membership:write." /> : null}
          {grantMutation.error ? <MutationBanner tone="error" message={grantMutation.error instanceof Error ? grantMutation.error.message : "Không thể cấp grant."} /> : null}
          <SelectField label="Permission" value={grantPermission} onChange={(event) => setGrantPermission(event.target.value)}>
            {SENSITIVE_PERMISSIONS.map((permissionId) => <option key={permissionId} value={permissionId}>{permissionId}</option>)}
          </SelectField>
          <TextArea label="Lý do" value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
          <div className="space-y-2">
            {(selectedOperator?.explicitGrants || []).filter((grant) => isEffectivePlatformOperatorGrant(grant)).map((grant) => (
              <div key={grant.grantId} className="flex items-center justify-between gap-2 rounded-md border border-border-default p-2">
                <span className="min-w-0 truncate text-xs text-text-secondary">{grant.permissionId}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => revokeMutation.mutate(grant.grantId)}
                  disabled={!canWritePlatformMemberships || revokeMutation.isPending}
                >
                  <ShieldX size={14} />
                  Thu hồi
                </Button>
              </div>
            ))}
          </div>
        </div>
      </ConfirmDialog>
    </div>
  );
}
