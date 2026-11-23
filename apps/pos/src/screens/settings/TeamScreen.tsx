import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  ConfirmDialog,
  Drawer,
  PaginatedListFrame,
  loadedListPaginationMeta,
  MutationBanner,
  OperationalTable,
  PageHeader,
  Panel,
  ScreenState,
  StatusPill,
  TableSkeleton,
} from "@medusa-snus/ui";
import { Copy, History, KeyRound, Pencil, Power, PowerOff, UserPlus } from "lucide-react";
import {
  createTeamOperator,
  disableTeamMembership,
  enableTeamMembership,
  fetchTeamOperatorAudit,
  fetchStores,
  fetchTeamMembers,
  resetTeamOperatorPassword,
  updateTeamMembership,
  updateTeamOperatorProfile,
  type CreateTeamOperatorInput,
  type TeamMemberDto,
  type UpdateTeamMembershipInput,
  type UpdateTeamOperatorProfileInput,
} from "../../api/settings-endpoints";
import { TextField, SelectField, TextArea } from "./FormField";
import {
  canDisableTeamMembership,
  canEnableTeamMembership,
  TEAM_MEMBER_STATUS_LABEL,
  TEAM_MEMBER_STATUS_TONE,
  teamMemberAuthorityDetail,
} from "./team-member-state";
import { useSettingsOwner } from "./useSettingsOwner";

const ROLE_LABEL: Record<string, string> = {
  staff: "Nhân viên",
  manager: "Quản lý",
  accountant: "Kế toán",
  owner: "Chủ sở hữu",
};

type SecretState = { operatorId: string; temporaryPassword: string } | null;
type EditForm = UpdateTeamOperatorProfileInput & Required<Pick<UpdateTeamMembershipInput, "role" | "scopeType">> & {
  storeId: string | null;
};

const initialCreateForm: CreateTeamOperatorInput = {
  operatorId: "",
  displayName: "",
  role: "staff",
  scopeType: "merchant",
  storeId: null,
  email: "",
  phoneE164: "",
};

export default function TeamScreen() {
  const queryClient = useQueryClient();
  const { merchantId, canManageTeam } = useSettingsOwner();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateTeamOperatorInput>(initialCreateForm);
  const [secret, setSecret] = useState<SecretState>(null);
  const [disableTarget, setDisableTarget] = useState<TeamMemberDto | null>(null);
  const [disableReason, setDisableReason] = useState("");
  const [editTarget, setEditTarget] = useState<TeamMemberDto | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [auditTarget, setAuditTarget] = useState<TeamMemberDto | null>(null);
  const [teamPage, setTeamPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);

  const teamQuery = useQuery({
    queryKey: ["team", merchantId],
    queryFn: () => fetchTeamMembers(merchantId!),
    enabled: !!merchantId && canManageTeam,
  });
  const storesQuery = useQuery({
    queryKey: ["settings-stores", merchantId],
    queryFn: () => fetchStores(merchantId!),
    enabled: !!merchantId && canManageTeam,
  });
  const auditQuery = useQuery({
    queryKey: ["team-audit", auditTarget?.membershipId],
    queryFn: () => fetchTeamOperatorAudit(auditTarget!.membershipId),
    enabled: Boolean(auditTarget?.membershipId),
  });

  const invalidateTeam = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["team", merchantId] }),
      queryClient.invalidateQueries({ queryKey: ["me"] }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: (input: CreateTeamOperatorInput) => createTeamOperator(merchantId!, input),
    onSuccess: async (result) => {
      setCreateOpen(false);
      setCreateForm(initialCreateForm);
      setSecret({
        operatorId: result.data.operatorId,
        temporaryPassword: result.data.temporaryPassword,
      });
      await invalidateTeam();
    },
  });

  const resetMutation = useMutation({
    mutationFn: resetTeamOperatorPassword,
    onSuccess: async (result) => {
      setSecret({
        operatorId: result.data.operatorId,
        temporaryPassword: result.data.temporaryPassword,
      });
      await invalidateTeam();
    },
  });

  const disableMutation = useMutation({
    mutationFn: ({ membershipId, reason }: { membershipId: string; reason?: string }) => disableTeamMembership(membershipId, { reason }),
    onSuccess: async () => {
      setDisableTarget(null);
      setDisableReason("");
      await invalidateTeam();
    },
  });

  const enableMutation = useMutation({
    mutationFn: enableTeamMembership,
    onSuccess: invalidateTeam,
  });
  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editTarget || !editForm) throw new Error("No team member selected");
      await updateTeamOperatorProfile(editTarget.membershipId, {
        displayName: editForm.displayName,
        email: editForm.email || null,
        phoneE164: editForm.phoneE164 || null,
      });
      await updateTeamMembership(editTarget.membershipId, {
        role: editForm.role,
        scopeType: editForm.scopeType,
        storeId: editForm.scopeType === "store" ? editForm.storeId : null,
      });
    },
    onSuccess: async () => {
      setEditTarget(null);
      setEditForm(null);
      await invalidateTeam();
    },
  });

  const team = teamQuery.data?.data || [];
  const stores = storesQuery.data?.data || [];
  const sortedTeam = useMemo(() => [...team].sort((left, right) => left.displayName.localeCompare(right.displayName)), [team]);
  const teamPageMeta = loadedListPaginationMeta(sortedTeam.length, teamPage, 20);
  const visibleTeam = sortedTeam.slice((teamPageMeta.page - 1) * 20, teamPageMeta.page * 20);
  const auditEvents = auditQuery.data?.data || [];
  const auditPageMeta = loadedListPaginationMeta(auditEvents.length, auditPage, 20);
  const visibleAuditEvents = auditEvents.slice((auditPageMeta.page - 1) * 20, auditPageMeta.page * 20);

  useEffect(() => setTeamPage(1), [merchantId]);
  useEffect(() => setAuditPage(1), [auditTarget?.membershipId]);

  function openEdit(member: TeamMemberDto) {
    setEditTarget(member);
    setEditForm({
      displayName: member.displayName,
      email: member.email || "",
      phoneE164: member.phoneE164 || "",
      role: member.role === "manager" || member.role === "accountant" ? member.role : "staff",
      scopeType: member.scopeType,
      storeId: member.storeId || null,
    });
  }

  if (!canManageTeam) {
    return (
      <div className="p-4">
        <PageHeader title="Nhóm nhân viên" />
        <ScreenState state="error" title="Không có quyền" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Nhóm nhân viên"
        subtitle="Quản lý tài khoản POS theo merchant và cửa hàng."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <UserPlus size={16} />
            Tạo nhân viên
          </Button>
        }
      />

      <Panel title="Thành viên">
        {teamQuery.isLoading ? (
          <TableSkeleton rows={5} cols={7} />
        ) : teamQuery.error ? (
          <div className="p-4">
            <ScreenState state="error" title="Không thể tải danh sách" actionLabel="Thử lại" onAction={() => teamQuery.refetch()} />
          </div>
        ) : sortedTeam.length === 0 ? (
          <div className="p-4">
            <ScreenState state="empty" title="Chưa có thành viên" body="Tạo nhân viên đầu tiên để cấp tài khoản POS." />
          </div>
        ) : (
          <>
          <PaginatedListFrame
            label="Phân trang nhân viên"
            rowNoun="nhân viên"
            meta={teamPageMeta}
            onPageChange={setTeamPage}
          >
            <OperationalTable
              ariaLabel="Thành viên"
              minWidth={980}
              columns={[
                { key: "name", label: "Nhân viên" },
                { key: "role", label: "Vai trò" },
                { key: "scope", label: "Phạm vi" },
                { key: "status", label: "Trạng thái" },
                { key: "joined", label: "Tham gia" },
                { key: "actions", label: "Thao tác", align: "right" },
              ]}
              rows={visibleTeam.map((member) => ({
                name: (
                  <div className="min-w-0">
                    <div className="font-medium text-text-primary break-words">{member.displayName}</div>
                    <div className="text-xs text-text-muted">{member.operatorId}</div>
                  </div>
                ),
                role: <StatusPill tone="info" label={ROLE_LABEL[member.role] || member.role} />,
                scope: (
                  <span className="break-words">
                    {member.scopeType === "store"
                      ? member.storeName || member.storeId || "Cửa hàng"
                      : "Toàn merchant"}
                  </span>
                ),
                status: (
                  <div className="space-y-1">
                    <StatusPill
                      tone={TEAM_MEMBER_STATUS_TONE[member.status]}
                      label={TEAM_MEMBER_STATUS_LABEL[member.status]}
                    />
                    {teamMemberAuthorityDetail(member) ? (
                      <div className="max-w-52 text-xs text-text-muted">
                        {teamMemberAuthorityDetail(member)}
                      </div>
                    ) : null}
                  </div>
                ),
                joined: (
                  <span className="text-xs text-text-muted">
                    {new Date(member.joinedAt).toLocaleDateString("vi-VN")}
                  </span>
                ),
                actions:
                  member.role === "owner" ? (
                    <span className="text-xs text-text-muted">Chủ sở hữu</span>
                  ) : (
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openEdit(member)}
                        disabled={updateMutation.isPending}
                      >
                        <Pencil size={14} />
                        Sửa
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => resetMutation.mutate(member.membershipId)}
                        disabled={resetMutation.isPending}
                      >
                        <KeyRound size={14} />
                        Reset mật khẩu
                      </Button>
                      {canDisableTeamMembership(member) ? (
                        <Button variant="danger" size="sm" onClick={() => setDisableTarget(member)}>
                          <PowerOff size={14} />
                          Khóa
                        </Button>
                      ) : canEnableTeamMembership(member) ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => enableMutation.mutate(member.membershipId)}
                          disabled={enableMutation.isPending}
                        >
                          <Power size={14} />
                          Mở khóa
                        </Button>
                      ) : null}
                      <Button variant="secondary" size="sm" onClick={() => setAuditTarget(member)}>
                        <History size={14} />
                        Lịch sử
                      </Button>
                    </div>
                  ),
              }))}
            />
          </PaginatedListFrame>
          </>
        )}
      </Panel>

      <Drawer
        open={createOpen}
        title="Tạo nhân viên"
        subtitle="Hệ thống tạo mật khẩu tạm thời và yêu cầu đổi mật khẩu khi đăng nhập."
        size="wide"
        onClose={() => setCreateOpen(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Hủy</Button>
            <Button
              variant="primary"
              onClick={() => createMutation.mutate({
                ...createForm,
                storeId: createForm.scopeType === "store" ? createForm.storeId : null,
                email: createForm.email || null,
                phoneE164: createForm.phoneE164 || null,
              })}
              disabled={createMutation.isPending}
            >
              Tạo nhân viên
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createMutation.error ? (
            <MutationBanner tone="error" message={createMutation.error instanceof Error ? createMutation.error.message : "Không thể tạo nhân viên."} />
          ) : null}
          <div className="settings-form-grid">
            <TextField label="Tên đăng nhập / Username" value={createForm.operatorId} onChange={(event) => setCreateForm((current) => ({ ...current, operatorId: event.target.value }))} required autoComplete="username" />
            <TextField label="Tên hiển thị" value={createForm.displayName} onChange={(event) => setCreateForm((current) => ({ ...current, displayName: event.target.value }))} required />
            <TextField label="Email liên hệ" type="email" value={createForm.email || ""} onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))} />
            <TextField label="Số điện thoại" value={createForm.phoneE164 || ""} onChange={(event) => setCreateForm((current) => ({ ...current, phoneE164: event.target.value }))} />
            <SelectField label="Vai trò" value={createForm.role} onChange={(event) => setCreateForm((current) => ({ ...current, role: event.target.value as CreateTeamOperatorInput["role"] }))}>
              <option value="staff">Nhân viên</option>
              <option value="manager">Quản lý</option>
              <option value="accountant">Kế toán</option>
            </SelectField>
            <SelectField label="Phạm vi" value={createForm.scopeType} onChange={(event) => setCreateForm((current) => ({ ...current, scopeType: event.target.value as CreateTeamOperatorInput["scopeType"] }))}>
              <option value="merchant">Toàn merchant</option>
              <option value="store">Một cửa hàng</option>
            </SelectField>
            {createForm.scopeType === "store" ? (
              <SelectField label="Cửa hàng" value={createForm.storeId || ""} onChange={(event) => setCreateForm((current) => ({ ...current, storeId: event.target.value }))} required>
                <option value="">Chọn cửa hàng</option>
                {stores.map((store) => <option key={store.storeId} value={store.storeId}>{store.publicName || store.internalName}</option>)}
              </SelectField>
            ) : null}
          </div>
        </div>
      </Drawer>

      <Drawer
        open={Boolean(editTarget && editForm)}
        title="Sửa nhân viên"
        subtitle={editTarget ? `${editTarget.displayName} · ${editTarget.operatorId}` : undefined}
        size="wide"
        onClose={() => {
          setEditTarget(null);
          setEditForm(null);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setEditTarget(null);
                setEditForm(null);
              }}
            >
              Hủy
            </Button>
            <Button
              variant="primary"
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending || !editForm}
            >
              Lưu thay đổi
            </Button>
          </>
        }
      >
        {editForm ? (
          <div className="space-y-4">
            {updateMutation.error ? (
              <MutationBanner tone="error" message={updateMutation.error instanceof Error ? updateMutation.error.message : "Không thể cập nhật nhân viên."} />
            ) : null}
            <div className="settings-form-grid">
              <TextField label="Tên hiển thị" value={editForm.displayName || ""} onChange={(event) => setEditForm((current) => current && ({ ...current, displayName: event.target.value }))} required />
              <TextField label="Email liên hệ" type="email" value={editForm.email || ""} onChange={(event) => setEditForm((current) => current && ({ ...current, email: event.target.value }))} />
              <TextField label="Số điện thoại" value={editForm.phoneE164 || ""} onChange={(event) => setEditForm((current) => current && ({ ...current, phoneE164: event.target.value }))} />
              <SelectField label="Vai trò" value={editForm.role} onChange={(event) => setEditForm((current) => current && ({ ...current, role: event.target.value as EditForm["role"] }))}>
                <option value="staff">Nhân viên</option>
                <option value="manager">Quản lý</option>
                <option value="accountant">Kế toán</option>
              </SelectField>
              <SelectField label="Phạm vi" value={editForm.scopeType} onChange={(event) => setEditForm((current) => current && ({ ...current, scopeType: event.target.value as EditForm["scopeType"], storeId: event.target.value === "store" ? current.storeId : null }))}>
                <option value="merchant">Toàn merchant</option>
                <option value="store">Một cửa hàng</option>
              </SelectField>
              {editForm.scopeType === "store" ? (
                <SelectField label="Cửa hàng" value={editForm.storeId || ""} onChange={(event) => setEditForm((current) => current && ({ ...current, storeId: event.target.value }))} required>
                  <option value="">Chọn cửa hàng</option>
                  {stores.map((store) => <option key={store.storeId} value={store.storeId}>{store.publicName || store.internalName}</option>)}
                </SelectField>
              ) : null}
            </div>
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={Boolean(auditTarget)}
        title="Lịch sử nhân viên"
        subtitle={auditTarget ? `${auditTarget.displayName} · ${auditTarget.operatorId}` : undefined}
        size="wide"
        onClose={() => setAuditTarget(null)}
      >
        {auditQuery.isLoading ? (
          <TableSkeleton rows={4} cols={4} />
        ) : auditQuery.error ? (
          <ScreenState state="error" title="Không thể tải lịch sử" actionLabel="Thử lại" onAction={() => auditQuery.refetch()} />
        ) : !auditEvents.length ? (
          <ScreenState state="empty" title="Chưa có bản ghi lịch sử" />
        ) : (
          <>
          <PaginatedListFrame
            label="Phân trang lịch sử nhân viên"
            rowNoun="bản ghi"
            meta={auditPageMeta}
            onPageChange={setAuditPage}
          >
            <OperationalTable
              ariaLabel="Lịch sử nhân viên"
              minWidth={760}
              columns={[
                { key: "time", label: "Thời gian" },
                { key: "action", label: "Hành động" },
                { key: "actor", label: "Actor" },
                { key: "reason", label: "Lý do" },
              ]}
              rows={visibleAuditEvents.map((event) => ({
                time: (
                  <span className="text-xs text-text-muted">
                    {new Date(event.createdAt).toLocaleString("vi-VN")}
                  </span>
                ),
                action: <span className="font-medium">{event.action}</span>,
                actor: <span className="font-mono text-xs">{event.actorId}</span>,
                reason: event.reason || <span className="text-text-muted">-</span>,
              }))}
            />
          </PaginatedListFrame>
          </>
        )}
      </Drawer>

      <ConfirmDialog
        open={Boolean(secret)}
        title="Mật khẩu tạm thời đã được tạo"
        message="Sao chép mật khẩu này ngay bây giờ. Hệ thống chỉ hiển thị một lần. Nhân viên sẽ phải đổi mật khẩu sau khi đăng nhập."
        confirmLabel="Đã lưu mật khẩu"
        onConfirm={() => setSecret(null)}
        onCancel={() => undefined}
      >
        <div className="space-y-2">
          <div className="rounded-md border border-border-default bg-surface-subtle p-3 font-mono text-sm text-text-primary break-all">
            {secret?.temporaryPassword}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => secret?.temporaryPassword && navigator.clipboard?.writeText(secret.temporaryPassword)}
          >
            <Copy size={14} />
            Sao chép
          </Button>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(disableTarget)}
        title="Khóa tài khoản này?"
        message={disableTarget ? `${disableTarget.displayName} sẽ mất quyền truy cập POS và Telegram.` : undefined}
        confirmLabel="Khóa tài khoản"
        danger
        pending={disableMutation.isPending}
        onCancel={() => setDisableTarget(null)}
        onConfirm={() => disableTarget && disableMutation.mutate({ membershipId: disableTarget.membershipId, reason: disableReason })}
      >
        <TextArea
          label="Lý do"
          value={disableReason}
          onChange={(event) => setDisableReason(event.target.value)}
          rows={3}
        />
      </ConfirmDialog>
    </div>
  );
}
