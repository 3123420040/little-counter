import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IntegrationConfigScope, PaymentProviderKey, ProviderConfigPurpose } from "@medusa-snus/contracts";
import { Button, PaginatedListFrame, loadedListPaginationMeta, OperationalTable, PageHeader, Panel, ScreenState, StatusPill, TableSkeleton } from "@medusa-snus/ui";
import { fetchPlatformIntegrations, mutateProviderConfig, type ProviderAction } from "../../api/settings-endpoints";
import { Field, TextField, SelectField } from "../settings/FormField";
import { PasswordInput } from "../../components/PasswordInput";
import { usePlatformAdmin } from "./usePlatformAdmin";
import {
  PLATFORM_CONFIG_PURPOSE_OPTIONS,
  buildPlatformProviderConfigInput,
  canShowPlatformIntegrationWriteForm,
  platformIntegrationPurposeForScope,
  platformIntegrationReadiness,
  platformIntegrationTargetLabel,
  type PlatformIntegrationFormInput,
} from "./platform-integration-contract";

type FormState = PlatformIntegrationFormInput;
const initial: FormState = {
  action: "set",
  providerKey: "nowpayments",
  purpose: "platform_billing",
  scope: "platform",
  merchantId: "",
  storeId: "",
};
const PROVIDER_OPTIONS = ["mock", "sepay_va", "nowpayments"] as const satisfies readonly PaymentProviderKey[];
const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info"> = { active: "success", inactive: "warning", error: "danger" };

function validate(form: FormState, hasSecretInput: boolean) {
  const errors: Partial<Record<keyof FormState | "secret", string>> = {};
  if (form.scope === "platform" && form.purpose !== "platform_billing") errors.purpose = "Platform scope chỉ dùng platform_billing.";
  if (form.scope !== "platform" && form.purpose !== "merchant_retail") errors.purpose = "Merchant/store scope chỉ dùng merchant_retail.";
  if (form.scope !== "platform" && !form.merchantId.trim()) errors.merchantId = "Merchant ID là bắt buộc cho merchant/store scope.";
  if (form.scope === "platform" && form.merchantId.trim()) errors.merchantId = "Không nhập merchant ID cho platform scope.";
  if (form.scope === "store" && !form.storeId.trim()) errors.storeId = "Store ID là bắt buộc cho store scope.";
  if (form.scope !== "store" && form.storeId.trim()) errors.storeId = "Chỉ nhập store ID cho store scope.";
  if (form.action !== "disable" && !hasSecretInput) errors.secret = "Secret chỉ được gửi một chiều và là bắt buộc.";
  return errors;
}

export default function PlatformIntegrationsScreen() {
  const { isPlatformAdmin, permissionIds } = usePlatformAdmin();
  const canShowWriteForm = canShowPlatformIntegrationWriteForm(permissionIds);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(initial);
  const [secret, setSecret] = useState("");
  const [page, setPage] = useState(1);
  const errors = validate(form, Boolean(secret));
  const query = useQuery({ queryKey: ["platformIntegrations"], queryFn: fetchPlatformIntegrations, enabled: isPlatformAdmin });
  const configs = query.data?.data || [];
  const pageMeta = loadedListPaginationMeta(configs.length, page, 20);
  const visibleConfigs = configs.slice((pageMeta.page - 1) * 20, pageMeta.page * 20);
  useEffect(() => setPage(1), [isPlatformAdmin]);
  const mutation = useMutation({ mutationFn: () => mutateProviderConfig(buildPlatformProviderConfigInput(form, secret)), onSuccess: () => { setSecret(""); queryClient.invalidateQueries({ queryKey: ["platformIntegrations"] }); } });
  if (!isPlatformAdmin) return <div className="p-4"><PageHeader title="Tích hợp" /><ScreenState state="error" title="Không có quyền" /></div>;
  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Tích hợp Platform" subtitle="Danh sách provider và form write-only Set/Replace/Rotate/Disable." />
      <Panel title="Mức sẵn sàng vận hành">
        <div className="space-y-3 p-4">
          <div className="rounded-lg border border-status-warning-border bg-status-warning-bg p-3 text-sm text-status-warning">
            Môi trường local dùng provider mock. Trạng thái “Đã cấu hình” và thao tác “Settle local test” chỉ chứng minh luồng local, không phải bằng chứng provider live hoặc phê duyệt production.
          </div>
          <PaginatedListFrame
            label="Phân trang mức sẵn sàng tích hợp"
            rowNoun="cấu hình"
            meta={pageMeta}
            onPageChange={setPage}
            showPagination={Boolean(configs.length)}
          >
            {query.isLoading ? (
              <TableSkeleton rows={3} cols={3} />
            ) : query.error ? (
              <ScreenState
                state="error"
                title="Không thể xác định mức sẵn sàng"
                actionLabel="Thử lại"
                onAction={() => query.refetch()}
              />
            ) : !query.data?.data.length ? (
              <ScreenState
                state="empty"
                title="Chưa có cấu hình provider"
                body="Cần tạo config đúng purpose và scope trước khi kiểm thử provider."
              />
            ) : (
              <div className="divide-y divide-border-default rounded-lg border border-border-default">
                {visibleConfigs.map((config) => {
                  const readiness = platformIntegrationReadiness(config);
                  return (
                    <div
                      key={config.configId}
                      className="grid gap-2 p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-text-primary break-words">
                          {config.providerKey} · {config.purpose}
                        </p>
                        <p className="mt-0.5 text-xs text-text-muted break-words">
                          {platformIntegrationTargetLabel(config)} · {readiness.detail}
                        </p>
                        {config.callbackUrl && (
                          <p className="mt-1 font-mono text-xs text-text-muted break-all">
                            Callback: {config.callbackUrl}
                          </p>
                        )}
                      </div>
                      <StatusPill tone={readiness.tone} label={readiness.label} />
                    </div>
                  );
                })}
              </div>
            )}
          </PaginatedListFrame>
        </div>
      </Panel>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.8fr)]">
        <Panel title="Provider configs">
          {query.isLoading ? <TableSkeleton rows={6} cols={6} /> : query.error ? <div className="p-4"><ScreenState state="error" title="Không thể tải" actionLabel="Thử lại" onAction={() => query.refetch()} /></div> : !query.data?.data.length ? <div className="p-4"><ScreenState state="empty" title="Chưa có config" /></div> : (
            <div>
            <PaginatedListFrame
              label="Phân trang cấu hình provider"
              rowNoun="cấu hình"
              meta={pageMeta}
              onPageChange={setPage}
            >
              <OperationalTable
                ariaLabel="Provider configs"
                columns={[
                  { key: "provider", label: "Provider" },
                  { key: "purpose", label: "Purpose" },
                  { key: "scope", label: "Scope" },
                  { key: "status", label: "Status" },
                  { key: "secret", label: "Secret" },
                  { key: "rotated", label: "Rotated" },
                ]}
                rows={visibleConfigs.map((c) => ({
                  provider: <span className="font-medium break-words">{c.providerKey}</span>,
                  purpose: <span className="break-words text-sm">{c.purpose}</span>,
                  scope: <span className="break-words">{platformIntegrationTargetLabel(c)}</span>,
                  status: <StatusPill tone={STATUS_TONE[c.status] || "info"} label={c.status} />,
                  secret: (
                    <StatusPill
                      tone={c.hasSecret ? "success" : "warning"}
                      label={c.hasSecret ? "Có secret" : "Chưa set"}
                    />
                  ),
                  rotated: c.lastRotatedAt ? (
                    <span className="text-xs text-text-muted">
                      {new Date(c.lastRotatedAt).toLocaleDateString("vi-VN")}
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
        <Panel title="Cấu hình write-only">
          {!canShowWriteForm ? (
            <div className="p-4">
              <ScreenState
                state="empty"
                title="Chỉ đọc"
                body="Tài khoản này chỉ có quyền xem cấu hình tích hợp; thao tác Set/Replace/Rotate/Disable yêu cầu integration_config:write."
              />
            </div>
          ) : (
            <div className="space-y-3 p-4">
              <SelectField label="Hành động" value={form.action} onChange={(e) => setForm((cur) => {
                const action = e.target.value as ProviderAction;
                if (action === "disable") {
                  setSecret("");
                }
                return { ...cur, action };
              })}>
                <option value="set">Set</option><option value="replace">Replace</option><option value="rotate">Rotate</option><option value="disable">Disable</option>
              </SelectField>
              <SelectField label="Provider key" value={form.providerKey} onChange={(e) => setForm((cur) => ({ ...cur, providerKey: e.target.value as PaymentProviderKey }))}>
                {PROVIDER_OPTIONS.map((providerKey) => <option key={providerKey} value={providerKey}>{providerKey}</option>)}
              </SelectField>
              <SelectField label="Purpose" value={form.purpose} onChange={(e) => setForm((cur) => ({ ...cur, purpose: e.target.value as ProviderConfigPurpose }))} error={errors.purpose}>
                {PLATFORM_CONFIG_PURPOSE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} disabled={(option.value === "platform_billing") !== (form.scope === "platform")}>{option.label}</option>
                ))}
              </SelectField>
              <SelectField label="Scope" value={form.scope} onChange={(e) => setForm((cur) => {
                const scope = e.target.value as IntegrationConfigScope;
                return {
                  ...cur,
                  scope,
                  purpose: platformIntegrationPurposeForScope(scope),
                  merchantId: scope === "platform" ? "" : cur.merchantId,
                  storeId: scope === "store" ? cur.storeId : "",
                };
              })}>
                <option value="platform">platform</option><option value="merchant">merchant</option><option value="store">store</option>
              </SelectField>
              <TextField label="Merchant ID" value={form.merchantId} disabled={form.scope === "platform"} onChange={(e) => setForm((cur) => ({ ...cur, merchantId: e.target.value }))} error={errors.merchantId} hint="Bắt buộc cho merchant/store scope; không có all scope." />
              <TextField label="Store ID" value={form.storeId} disabled={form.scope !== "store"} onChange={(e) => setForm((cur) => ({ ...cur, storeId: e.target.value }))} error={errors.storeId} hint="Bắt buộc khi scope=store." />
              <Field label="Secret / config payload" error={errors.secret} hint="Giá trị này chỉ được gửi lên server, không được đọc lại." required={form.action !== "disable"}>
                <PasswordInput
                  inputClassName={["settings-input", errors.secret ? "settings-input--error" : ""].filter(Boolean).join(" ")}
                  value={secret}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={form.action === "disable"}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </Field>
              {mutation.error && <ScreenState state="error" title="Không thể gửi cấu hình" body={mutation.error instanceof Error ? mutation.error.message : "Lỗi không xác định"} />}
              {mutation.isSuccess && <StatusPill tone="success" label="Đã gửi cấu hình write-only" />}
              <Button variant="primary" disabled={Object.keys(errors).length > 0 || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "Đang gửi..." : "Gửi cấu hình"}</Button>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
