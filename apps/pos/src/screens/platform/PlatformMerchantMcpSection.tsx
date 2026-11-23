import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ConfirmDialog, Panel } from "@medusa-snus/ui";
import { platformMcpIssuancePresetV1 } from "@medusa-snus/contracts";
import type {
  PlatformMcpConnectionDetailV1,
  PlatformMcpCommandResultV1,
  PlatformMcpCreateConnectionV1,
} from "@medusa-snus/contracts";
import type { PlatformMerchantDetailDto } from "../../api/settings-endpoints";
import {
  fetchPlatformMcpConnections,
  fetchPlatformMcpConnection,
  executePlatformMcpCommand,
  type PlatformMcpCommand,
} from "../../api/platform-mcp-endpoints";
import { ApiError, getToken, SCOPE_CHANGED_EVENT } from "../../api/client";
import { createClientIdempotencyKey } from "../../api/endpoints";
import { useAuth } from "../../hooks/useAuth";
import { TextField, TextArea, SelectField } from "../settings/FormField";
import { usePlatformAdmin } from "./usePlatformAdmin";

type Merchant = Pick<
  PlatformMerchantDetailDto,
  "merchantId" | "displayName" | "status" | "stores"
>;
type KeyMetadata = PlatformMcpConnectionDetailV1["keys"]["data"][number];
type Action = "create" | "issue" | "rotate" | "revoke" | "pause" | "resume";
type Delivery = Extract<
  PlatformMcpCommandResultV1,
  { secretStatus: "available_once" }
>;
const statusLabels = {
  active: "Đang hoạt động",
  paused: "Tạm dừng",
  inactive: "Chưa bật",
  revoked: "Đã thu hồi",
};
const actionLabels: Record<Action, string> = {
  create: "Tạo kết nối MCP",
  issue: "Cấp thêm key",
  rotate: "Xoay key",
  revoke: "Thu hồi key",
  pause: "Tạm dừng kết nối",
  resume: "Chọn quyền hoạt động",
};
const operationLabels = {
  create_connection: "Tạo kết nối",
  issue_key: "Cấp key",
  rotate_key: "Xoay key",
  revoke_key: "Thu hồi key",
  set_status: "Đổi trạng thái",
};
const scopeLabels = {
  "partner:read": "Xem kết nối",
  "catalog:read": "Danh mục",
  "inventory:read": "Tồn kho",
  "orders:read": "Đơn thuộc kết nối",
  "orders:quote": "Báo giá",
  "orders:write": "Tạo đơn COD",
};
const date = (value: string) => new Date(value).toLocaleString("vi-VN");
const denied = (error: unknown) =>
  error instanceof ApiError && [401, 403].includes(error.status);

function McpDialog({
  open,
  title,
  pending,
  disabled,
  danger,
  confirmLabel,
  onClose,
  onConfirm,
  children,
}: {
  open: boolean;
  title: string;
  pending: boolean;
  disabled?: boolean;
  danger?: boolean;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const stableClose = useCallback(() => close.current(), []);
  useEffect(() => {
    if (!open || pending) return;
    const dialog = root.current?.querySelector('[role="dialog"]');
    // Async submission can blur the disabled button while this dialog stays open.
    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    }
  }, [open, pending, title]);
  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget.querySelector('[role="dialog"]');
    const nodes = Array.from(
      dialog?.querySelectorAll<HTMLElement>(
        "button,input,textarea,select,a[href],[tabindex]",
      ) ?? [],
    ).filter(
      (node) =>
        !node.matches(":disabled") &&
        node.tabIndex >= 0 &&
        !node.closest("[hidden]"),
    );
    if (!nodes.length) return;
    event.preventDefault();
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    nodes[
      index < 0
        ? event.shiftKey
          ? nodes.length - 1
          : 0
        : (index + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length
    ].focus();
  }
  return (
    <div ref={root} onKeyDown={trapFocus}>
      <ConfirmDialog
        open={open}
        title={title}
        confirmLabel={confirmLabel}
        cancelLabel="Đóng"
        pending={pending}
        danger={danger}
        confirmDisabled={disabled}
        onCancel={stableClose}
        onConfirm={onConfirm}
      >
        <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
          {children}
        </div>
      </ConfirmDialog>
    </div>
  );
}

export function PlatformMerchantMcpSection({
  merchant,
}: {
  merchant: Merchant;
}) {
  const { operator, requiresPasswordChange } = useAuth(),
    token = getToken();
  const { canManageMerchantMcp } = usePlatformAdmin();
  const identity = useRef({
    merchantId: merchant.merchantId,
    operatorId: operator?.id,
    token,
    mayManage: canManageMerchantMcp,
    revision: 0,
  });
  const [, rerender] = useState(0);
  if (
    identity.current.merchantId !== merchant.merchantId ||
    identity.current.operatorId !== operator?.id ||
    identity.current.token !== token ||
    identity.current.mayManage !== canManageMerchantMcp
  ) {
    identity.current = {
      merchantId: merchant.merchantId,
      operatorId: operator?.id,
      token,
      mayManage: canManageMerchantMcp,
      revision: identity.current.revision + 1,
    };
  }
  useEffect(() => {
    const changed = () => {
      identity.current.revision++;
      rerender((value) => value + 1);
    };
    window.addEventListener(SCOPE_CHANGED_EVENT, changed);
    window.addEventListener("snus:unauthorized", changed);
    return () => {
      window.removeEventListener(SCOPE_CHANGED_EVENT, changed);
      window.removeEventListener("snus:unauthorized", changed);
    };
  }, []);
  if (!operator || !token || requiresPasswordChange) return null;
  const revision = identity.current.revision;
  return (
    <MerchantMcpSession
      key={`${merchant.merchantId}:${revision}`}
      merchant={merchant}
      operatorId={operator.id}
      revision={revision}
      mayManage={canManageMerchantMcp}
      isCurrent={() =>
        identity.current.revision === revision && getToken() === token
      }
    />
  );
}

function MerchantMcpSession({
  merchant,
  operatorId,
  revision,
  mayManage,
  isCurrent,
}: {
  merchant: Merchant;
  operatorId: string;
  revision: number;
  mayManage: boolean;
  isCurrent: () => boolean;
}) {
  const cache = useQueryClient(),
    [listPages, setListPages] = useState<Array<string | undefined>>([
      undefined,
    ]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pages, setPages] = useState<{
    keys: Array<string | undefined>;
    grants: Array<string | undefined>;
    receipts: Array<string | undefined>;
  }>({ keys: [undefined], grants: [undefined], receipts: [undefined] });
  const queryPrefix = [
    "platformMcp",
    operatorId,
    revision,
    merchant.merchantId,
  ];
  const list = useQuery({
    queryKey: [...queryPrefix, "list", listPages.at(-1)],
    queryFn: () =>
      fetchPlatformMcpConnections(merchant.merchantId, listPages.at(-1)),
  });
  const details = useQuery({
    queryKey: [...queryPrefix, "detail", selected, pages],
    enabled: !!selected,
    queryFn: () =>
      fetchPlatformMcpConnection(merchant.merchantId, selected!, {
        keysAfter: pages.keys.at(-1),
        grantsAfter: pages.grants.at(-1),
        receiptsAfter: pages.receipts.at(-1),
      }),
  });
  const info = details.data;
  const canManage =
    mayManage &&
    list.data?.canRevokeKeys === true &&
    !denied(list.error) &&
    !denied(details.error) &&
    (!info || info.canRevokeKeys);
  const live = useRef(true),
    authority = useRef(canManage),
    busy = useRef(false),
    controller = useRef<AbortController | null>(null);
  authority.current = canManage;
  const current = () => live.current && isCurrent() && authority.current;
  const [dialogOpen, setDialogOpen] = useState(false),
    [action, setAction] = useState<Action>("create"),
    [targetKey, setTargetKey] = useState<KeyMetadata | null>(null);
  const [name, setName] = useState(""),
    [label, setLabel] = useState(""),
    [storeIds, setStoreIds] = useState<string[]>([]);
  const [profile, setProfile] = useState<"read" | "commerce">("read"),
    [reason, setReason] =
      useState<PlatformMcpCreateConnectionV1["reason"]>("operator_request");
  const [pending, setPending] = useState(false),
    [blocked, setBlocked] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [delivery, setDelivery] = useState<Delivery | null>(null),
    [copyNotice, setCopyNotice] = useState("");
  const attempt = useRef<{ key: string; command: PlatformMcpCommand } | null>(
      null,
    ),
    returnFocus = useRef<HTMLElement | null>(null),
    objectUrl = useRef<string | null>(null);
  const actionInfo = useRef<PlatformMcpConnectionDetailV1 | null>(null);
  const clearUrl = () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      controller.current?.abort();
      clearUrl();
    };
  }, []);
  useEffect(() => {
    if (!canManage) {
      controller.current?.abort();
      setDelivery(null);
      clearUrl();
    }
  }, [canManage]);
  const refresh = () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: queryPrefix }),
      cache.invalidateQueries({ queryKey: ["me", operatorId] }),
    ]);
  function select(id: string | null) {
    setSelected(id);
    setPages({ keys: [undefined], grants: [undefined], receipts: [undefined] });
  }
  function start(next: Action, key?: KeyMetadata) {
    if (!current() || busy.current || uncertain || delivery) return;
    returnFocus.current = document.activeElement as HTMLElement;
    actionInfo.current = info ? structuredClone(info) : null;
    setAction(next);
    setTargetKey(key ? { ...key } : null);
    setName("");
    setLabel("");
    setStoreIds([]);
    setProfile("read");
    setReason(
      next === "create" || next === "issue"
        ? "onboarding"
        : next === "rotate"
          ? "credential_rotation"
          : "operator_request",
    );
    attempt.current = null;
    setBlocked(false);
    setError("");
    setNotice("");
    setDialogOpen(true);
  }
  function close() {
    if (busy.current) return;
    if (delivery) {
      const id = delivery.data.integrationId;
      setDelivery(null);
      setCopyNotice("");
      clearUrl();
      select(id);
    }
    setDialogOpen(false);
    if (!uncertain) attempt.current = null;
    returnFocus.current?.focus();
  }
  function command(): PlatformMcpCommand {
    if (action === "create")
      return {
        action: "create",
        input: {
          name: name.trim(),
          ...(label.trim() ? { label: label.trim() } : {}),
          storeIds: [...storeIds],
          profile,
          reason,
        },
      };
    const snapshot = actionInfo.current;
    if (!snapshot) throw new Error("Missing connection metadata");
    const integrationId = snapshot.connection.integrationId,
      expectedIntegrationVersion = snapshot.connection.integrationVersion,
      expectedAuthorizationSnapshotSha256 =
        snapshot.authorizationSnapshotSha256!;
    if (action === "issue")
      return {
        action: "issue",
        integrationId,
        input: {
          ...(label.trim() ? { label: label.trim() } : {}),
          profile,
          reason,
          expectedIntegrationVersion,
          expectedAuthorizationSnapshotSha256,
        },
      };
    if (action === "rotate")
      return {
        action: "rotate",
        integrationId,
        keyId: targetKey!.id,
        input: {
          expectedKeyVersion: targetKey!.version,
          expectedIntegrationVersion,
          expectedAuthorizationSnapshotSha256,
          reason: "credential_rotation",
        },
      };
    if (action === "revoke")
      return {
        action: "revoke",
        integrationId,
        keyId: targetKey!.id,
        input: { expectedKeyVersion: targetKey!.version, reason },
      };
    return {
      action: "status",
      integrationId,
      input:
        action === "pause"
          ? { status: "paused", expectedIntegrationVersion, reason }
          : {
              status: "active",
              expectedIntegrationVersion,
              expectedAuthorizationSnapshotSha256,
              profile,
              reason,
            },
    };
  }
  async function submit() {
    if (
      !current() ||
      busy.current ||
      blocked ||
      !validForm ||
      label.trim().length > 128
    )
      return;
    busy.current = true;
    setPending(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 15_000);
    try {
      attempt.current ??= {
        key: createClientIdempotencyKey(`platform-mcp-${action}`),
        command: command(),
      };
      const executed = attempt.current.command;
      const result = await executePlatformMcpCommand(
        merchant.merchantId,
        executed,
        attempt.current.key,
        abort.signal,
      );
      if (!current()) return;
      if (abort.signal.aborted)
        throw new DOMException("MCP command deadline elapsed", "AbortError");
      attempt.current = null;
      setUncertain(false);
      setDialogOpen(false);
      if (result.secretStatus === "available_once") setDelivery(result);
      else {
        setNotice(
          result.replayed
            ? ["create", "issue", "rotate"].includes(executed.action)
              ? "Yêu cầu đã được ghi nhận; key không thể hiển thị lại. Chọn key để xoay hoặc thu hồi nếu chưa lưu cấu hình."
              : "Yêu cầu đã được ghi nhận. Tải lại chi tiết để xem trạng thái mới nhất."
            : "Đã cập nhật kết nối MCP.",
        );
        select(result.data.integrationId);
      }
      void refresh();
    } catch (failure) {
      if (!current()) return;
      const known =
        failure instanceof ApiError &&
        ((failure.status >= 400 && failure.status < 500) ||
          failure.code === "mcp_readiness_unavailable");
      setUncertain(!known);
      setBlocked(known);
      setError(
        known
          ? failure.code === "mcp_readiness_unavailable"
            ? "Hạ tầng MCP chưa đủ điều kiện cấp quyền. Tải lại metadata; vẫn có thể thu hồi key hoặc tạm dừng kết nối."
            : denied(failure)
              ? "Phiên đăng nhập hoặc quyền quản trị đã thay đổi. Tải lại để kiểm tra quyền."
              : "Yêu cầu không còn phù hợp hoặc dữ liệu đã thay đổi. Tải lại chi tiết trước khi thao tác tiếp."
          : "Chưa xác nhận được kết quả. Thử lại cùng yêu cầu để kiểm tra; không tạo thêm yêu cầu mới.",
      );
    } finally {
      clearTimeout(timeout);
      busy.current = false;
      if (live.current && isCurrent()) setPending(false);
    }
  }
  async function copy() {
    if (!current() || !delivery) return;
    try {
      await navigator.clipboard.writeText(delivery.revealedKey);
      if (current()) setCopyNotice("Đã sao chép key.");
    } catch {
      if (current())
        setCopyNotice("Chưa sao chép được. Chọn key và sao chép thủ công.");
    }
  }
  function download() {
    if (!current() || !delivery) return;
    clearUrl();
    objectUrl.current = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              url: delivery.data.mcpUrl,
              transport: "streamable-http",
              headers: { Authorization: `Bearer ${delivery.revealedKey}` },
              merchantId: delivery.data.merchantId,
              integrationId: delivery.data.integrationId,
              keyId: delivery.data.key!.id,
              scopes: delivery.data.key!.scopes,
              expiresAt: delivery.data.key!.expiresAt,
              writesEnabled: delivery.data.writesEnabled,
              ...(action === "create"
                ? {
                    storeIds,
                    catalogMode: "merchant_published",
                    policyVersion: platformMcpIssuancePresetV1.version,
                  }
                : {
                    scopeDetailsPath: `/platform/merchants/${encodeURIComponent(merchant.merchantId)}#merchant-mcp`,
                  }),
              ...(delivery.rotation ? { rotation: delivery.rotation } : {}),
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const link = document.createElement("a");
    link.href = objectUrl.current;
    link.download = `mcp-${encodeURIComponent(merchant.merchantId)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
  const available = canManage && !uncertain && !pending && !delivery;
  const active = merchant.status === "active",
    approved =
      !!info?.authorizationSnapshotSha256 && !info.authorizationWarning;
  const dedicated =
      info?.connection.managedByPlatform && !info.connection.hasOauthClients,
    terminal = info?.connection.status === "revoked";
  const formLocked = pending || !!attempt.current;
  const canCommerce =
    action === "create" ||
    (actionInfo.current?.connection.managedByPlatform &&
      !actionInfo.current.connection.hasOauthClients &&
      actionInfo.current.maxApprovedProfile === "commerce");
  const validForm =
    action !== "create" ||
    (name.trim().length > 0 &&
      name.trim().length <= 120 &&
      storeIds.length > 0 &&
      storeIds.length <= 20 &&
      storeIds.every((id) =>
        merchant.stores.some(
          (store) => store.storeId === id && store.effectiveStatus === "active",
        ),
      ));
  function pager(kind: "keys" | "grants" | "receipts", labelText: string) {
    const cursors = pages[kind],
      next = info?.[kind].nextAfter;
    return (
      <nav
        aria-label={`Phân trang ${labelText}`}
        className="flex flex-wrap gap-2 py-2"
      >
        <Button
          variant="secondary"
          disabled={details.isFetching || cursors.length < 2}
          onClick={() =>
            setPages((value) => ({
              ...value,
              [kind]: value[kind].slice(0, -1),
            }))
          }
        >
          {labelText}: trước
        </Button>
        <Button
          variant="secondary"
          disabled={details.isFetching || !next}
          onClick={() =>
            setPages((value) => ({ ...value, [kind]: [...value[kind], next!] }))
          }
        >
          {labelText}: sau
        </Button>
      </nav>
    );
  }
  if (!isCurrent()) return null;
  return (
    <section id="merchant-mcp">
      <Panel title="Kết nối MCP">
        <div className="space-y-4 p-4">
          <p className="text-sm text-text-secondary">
            Cấp cấu hình Bearer key cho agent của merchant. Key chỉ hiển thị một
            lần; cấp cấu hình chưa xác nhận client đã kết nối.
          </p>
          {canManage && (
            <Button
              disabled={
                !available ||
                !active ||
                !merchant.stores.some(
                  (store) => store.effectiveStatus === "active",
                )
              }
              onClick={() => start("create")}
            >
              Tạo kết nối MCP
            </Button>
          )}
          {!active && (
            <p className="text-sm">
              Merchant không hoạt động; có thể xem metadata, tạm dừng kết nối
              hoặc thu hồi key.
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
          {uncertain && !dialogOpen && (
            <div role="alert">
              <p>
                Chưa xác nhận kết quả yêu cầu trước. Hãy kiểm tra cùng yêu cầu.
              </p>
              <Button variant="secondary" onClick={() => setDialogOpen(true)}>
                Mở lại yêu cầu
              </Button>
            </div>
          )}
          {list.isPending ? (
            <p role="status">Đang tải kết nối MCP…</p>
          ) : list.isError ? (
            <div role="alert">
              Không tải được metadata MCP.{" "}
              <Button variant="secondary" onClick={() => void list.refetch()}>
                Thử lại metadata
              </Button>
            </div>
          ) : (
            <>
              <ul className="space-y-2">
                {list.data?.data.length === 0 && <li>Chưa có kết nối MCP.</li>}
                {list.data?.data.map((row) => (
                  <li key={row.integrationId}>
                    <Button
                      variant="secondary"
                      aria-pressed={selected === row.integrationId}
                      onClick={() => select(row.integrationId)}
                    >
                      {row.name} · {statusLabels[row.status]}
                    </Button>
                  </li>
                ))}
              </ul>
              <nav
                aria-label="Phân trang kết nối MCP"
                className="flex flex-wrap gap-2"
              >
                <Button
                  variant="secondary"
                  disabled={list.isFetching || listPages.length < 2}
                  onClick={() => setListPages((value) => value.slice(0, -1))}
                >
                  Kết nối: trước
                </Button>
                <Button
                  variant="secondary"
                  disabled={list.isFetching || !list.data?.nextAfter}
                  onClick={() =>
                    setListPages((value) => [...value, list.data!.nextAfter!])
                  }
                >
                  Kết nối: sau
                </Button>
              </nav>
            </>
          )}
          {selected && (
            <div className="space-y-3 border-t border-border pt-4">
              <Button variant="secondary" onClick={() => select(null)}>
                Đóng chi tiết kết nối
              </Button>
              {details.isPending ? (
                <p>Đang tải chi tiết MCP…</p>
              ) : details.isError ? (
                <div role="alert">
                  Không tải được chi tiết MCP.{" "}
                  <Button
                    variant="secondary"
                    onClick={() => void details.refetch()}
                  >
                    Tải lại chi tiết MCP
                  </Button>
                </div>
              ) : (
                info && (
                  <>
                    <h3 className="font-semibold">{info.connection.name}</h3>
                    <p className="break-all text-sm">
                      {info.connection.integrationId} ·{" "}
                      {info.connection.environment} ·{" "}
                      {statusLabels[info.connection.status]}
                    </p>
                    <p className="break-all text-sm">
                      URL: {info.mcpUrl ?? "Chưa có địa chỉ MCP"}
                    </p>
                    <p className="text-sm">
                      Quyền tạo đơn hiện tại:{" "}
                      {info.connection.writesEnabled ? "Bật" : "Tắt"}. Phạm vi
                      đơn hàng chỉ gồm đơn thuộc kết nối này.
                    </p>
                    {(!dedicated || info.authorizationWarning) && (
                      <p role="status" className="text-sm">
                        {info.authorizationWarning
                          ? "Cấu hình phê duyệt cần kiểm tra; vẫn có thể thu hồi key."
                          : "Kết nối cũ hoặc dùng chung OAuth: key cấp thêm chỉ có quyền đọc; giữ nguyên cấu hình kết nối."}
                      </p>
                    )}
                    {canManage && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={
                            !available || !active || !approved || terminal
                          }
                          onClick={() => start("issue")}
                        >
                          Cấp thêm key
                        </Button>
                        {dedicated && !terminal && (
                          <>
                            <Button
                              variant="secondary"
                              disabled={
                                !available ||
                                info.connection.status === "paused"
                              }
                              onClick={() => start("pause")}
                            >
                              Tạm dừng kết nối
                            </Button>
                            <Button
                              variant="secondary"
                              disabled={!available || !active || !approved}
                              onClick={() => start("resume")}
                            >
                              {info.connection.status === "paused"
                                ? "Bật lại kết nối"
                                : "Chọn quyền hoạt động"}
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                    <h4 className="font-semibold">Key MCP</h4>
                    <ul className="space-y-3">
                      {info.keys.data.length === 0 && <li>Chưa có key.</li>}
                      {info.keys.data.map((key) => (
                        <li
                          key={key.id}
                          className="rounded-xl border border-border p-3 text-sm"
                        >
                          <p className="break-words font-medium">{key.label}</p>
                          <p className="break-all">{key.id}</p>
                          <p>
                            {key.status === "revoked"
                              ? "Đã thu hồi"
                              : new Date(key.expiresAt).getTime() <= Date.now()
                                ? "Đã hết hạn"
                                : "Còn hiệu lực"}{" "}
                            · Hết hạn {date(key.expiresAt)}
                          </p>
                          <p className="break-words">
                            {key.scopes
                              .map((scope) => scopeLabels[scope])
                              .join(", ")}
                          </p>
                          {canManage && key.status === "active" && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              <Button
                                variant="secondary"
                                disabled={
                                  !available ||
                                  !active ||
                                  !approved ||
                                  terminal ||
                                  new Date(key.expiresAt).getTime() <=
                                    Date.now()
                                }
                                onClick={() => start("rotate", key)}
                              >
                                Xoay key
                              </Button>
                              <Button
                                variant="danger"
                                disabled={!available}
                                onClick={() => start("revoke", key)}
                              >
                                Thu hồi key
                              </Button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                    {pager("keys", "Key")}
                    <h4 className="font-semibold">Cửa hàng được cấp</h4>
                    <ul className="space-y-2 text-sm">
                      {info.grants.data.map((grant) => (
                        <li key={grant.storeId}>
                          {merchant.stores.find(
                            (store) => store.storeId === grant.storeId,
                          )?.internalName ?? grant.storeId}{" "}
                          · {grant.status} ·{" "}
                          {grant.catalogMode === "merchant_published"
                            ? "Toàn bộ hàng đang bán"
                            : "Danh sách đã chọn"}
                        </li>
                      ))}
                    </ul>
                    {pager("grants", "Cửa hàng")}
                    <h4 className="font-semibold">Lịch sử yêu cầu</h4>
                    <ul className="space-y-2 text-sm">
                      {info.receipts.data.map((receipt) => (
                        <li key={receipt.receiptId} className="break-words">
                          {operationLabels[receipt.operation]} ·{" "}
                          {receipt.actorId} · {date(receipt.createdAt)}
                          {receipt.state === "tombstone"
                            ? " · Chỉ còn thông tin đối chiếu"
                            : ""}
                        </li>
                      ))}
                    </ul>
                    {pager("receipts", "Lịch sử")}
                  </>
                )
              )}
            </div>
          )}
          <McpDialog
            open={(dialogOpen || !!delivery) && canManage}
            title={delivery ? "Lưu cấu hình MCP ngay" : actionLabels[action]}
            pending={pending}
            danger={!delivery && (action === "revoke" || action === "pause")}
            disabled={
              !delivery && (blocked || !validForm || label.trim().length > 128)
            }
            confirmLabel={
              delivery
                ? "Đã lưu, đóng"
                : uncertain
                  ? "Thử lại cùng yêu cầu"
                  : action === "create"
                    ? "Xác nhận cấp MCP"
                    : "Xác nhận"
            }
            onClose={close}
            onConfirm={() => {
              if (delivery) close();
              else void submit();
            }}
          >
            {delivery ? (
              <>
                <p className="text-sm">
                  Key chỉ hiển thị lần này. Chưa xác minh client đã kết nối. Lưu
                  vào cấu hình riêng của client trước khi đóng.
                </p>
                <TextField
                  label="URL MCP"
                  value={delivery.data.mcpUrl ?? ""}
                  readOnly
                />
                <TextArea
                  label="MCP key chỉ hiển thị lần này"
                  aria-label="MCP key chỉ hiển thị lần này"
                  value={delivery.revealedKey}
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-sm">
                  Client gửi header Authorization: Bearer &lt;key&gt;. Hết hạn{" "}
                  {date(delivery.data.key!.expiresAt)}.
                </p>
                <p className="break-all text-sm">
                  Merchant: {delivery.data.merchantId} · Kết nối:{" "}
                  {delivery.data.integrationId} · Key: {delivery.data.key!.id}.
                  Quyền:{" "}
                  {delivery.data
                    .key!.scopes.map((scope) => scopeLabels[scope])
                    .join(", ")}
                  . Quyền tạo đơn hiện tại:{" "}
                  {delivery.data.writesEnabled ? "Bật" : "Tắt"}.
                </p>
                <p className="text-sm">
                  File tải về là hướng dẫn cấu hình trung lập; điều chỉnh theo
                  client sử dụng và giao file qua kênh riêng.
                  {action === "create"
                    ? ` Cửa hàng: ${storeIds.map((id) => merchant.stores.find((store) => store.storeId === id)?.internalName ?? id).join(", ")}. Catalog tự cập nhật hàng đang bán; cửa hàng mới phải cấp riêng.`
                    : " Xem đầy đủ cửa hàng/catalog tại chi tiết kết nối; các trang metadata không phải toàn bộ phạm vi."}
                </p>
                {delivery.rotation && (
                  <p className="text-sm">
                    Key cũ có hạn hiệu lực đến{" "}
                    {date(delivery.rotation.previousKeyExpiresAt)}; thu hồi nếu
                    cần ngừng ngay.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => void copy()}>
                    Sao chép key
                  </Button>
                  <Button variant="secondary" onClick={download}>
                    Tải cấu hình
                  </Button>
                </div>
                {copyNotice && <p role="status">{copyNotice}</p>}
              </>
            ) : (
              <>
                <p className="text-sm">
                  Merchant: {merchant.displayName}
                  {actionInfo.current && action !== "create"
                    ? ` · ${actionInfo.current.connection.name}`
                    : ""}
                  {targetKey ? ` · ${targetKey.label}` : ""}
                </p>
                {action === "create" && (
                  <>
                    <p className="text-sm">
                      Chính sách {platformMcpIssuancePresetV1.version}: VND, tối
                      đa {platformMcpIssuancePresetV1.policy.max_quantity} đơn
                      vị và{" "}
                      {platformMcpIssuancePresetV1.policy.max_order_total.toLocaleString(
                        "vi-VN",
                      )}{" "}
                      VND/đơn; chỉ nhận tại cửa hàng, thanh toán COD. Hạn key do
                      máy chủ quy định và hiển thị chính xác sau khi cấp.
                    </p>
                    <TextField
                      label="Tên kết nối MCP"
                      aria-label="Tên kết nối MCP"
                      value={name}
                      maxLength={120}
                      disabled={formLocked}
                      onChange={(event) => setName(event.target.value)}
                      required
                    />
                    <fieldset disabled={formLocked} className="space-y-2">
                      <legend className="text-sm font-medium">
                        Chọn cửa hàng (tối đa 20)
                      </legend>
                      {merchant.stores.map((store) => (
                        <label
                          className="flex items-start gap-2 text-sm"
                          key={store.storeId}
                        >
                          <input
                            type="checkbox"
                            checked={storeIds.includes(store.storeId)}
                            disabled={
                              store.effectiveStatus !== "active" ||
                              (storeIds.length >= 20 &&
                                !storeIds.includes(store.storeId))
                            }
                            onChange={(event) =>
                              setStoreIds((ids) =>
                                event.target.checked
                                  ? [...ids, store.storeId]
                                  : ids.filter((id) => id !== store.storeId),
                              )
                            }
                          />
                          {store.internalName}
                          {store.effectiveStatus !== "active"
                            ? " (không hoạt động)"
                            : ""}
                        </label>
                      ))}
                    </fieldset>
                    <p className="text-sm">
                      Tự thấy hàng đang bán hiện tại và thêm về sau. Cửa hàng
                      mới phải được cấp riêng.
                    </p>
                  </>
                )}
                {(action === "create" || action === "issue") && (
                  <TextField
                    label="Nhãn key (tùy chọn)"
                    value={label}
                    maxLength={128}
                    disabled={formLocked}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                )}
                {(["create", "issue", "resume"] as Action[]).includes(
                  action,
                ) && (
                  <>
                    <SelectField
                      label="Quyền MCP"
                      value={profile}
                      disabled={formLocked}
                      onChange={(event) =>
                        setProfile(
                          event.currentTarget.value === "commerce"
                            ? "commerce"
                            : "read",
                        )
                      }
                    >
                      <option value="read">Chỉ đọc</option>
                      <option value="commerce" disabled={!canCommerce}>
                        Đọc + tạo đơn
                      </option>
                    </SelectField>
                    <p className="text-sm">
                      {profile === "commerce"
                        ? "Cho phép báo giá và tạo đơn COD nhận tại cửa hàng; lên đơn sẽ trừ tồn kho. Client cần xác nhận khách trước khi tạo đơn."
                        : "Đọc danh mục, tồn kho và đơn thuộc kết nối; không được tạo đơn."}
                    </p>
                    {action !== "create" && (
                      <p className="text-sm">
                        Cấp key không tự bật kết nối. Bật lại mặc định chỉ đọc;
                        quyền tạo đơn phải chọn rõ.
                      </p>
                    )}
                  </>
                )}
                {action !== "rotate" && (
                  <SelectField
                    label="Lý do"
                    value={reason}
                    disabled={formLocked}
                    onChange={(event) =>
                      setReason(event.currentTarget.value as typeof reason)
                    }
                  >
                    <option value="onboarding">Thiết lập sử dụng</option>
                    <option value="operator_request">
                      Theo yêu cầu quản trị
                    </option>
                    <option value="security_incident">Xử lý bảo mật</option>
                    <option value="commercial_policy">
                      Điều chỉnh nghiệp vụ
                    </option>
                  </SelectField>
                )}
                {action === "rotate" && (
                  <p className="text-sm">
                    Giữ nguyên quyền key hiện có; key mới chỉ hiển thị một lần.
                    Hạn key cũ sẽ được xác nhận sau khi xoay.
                  </p>
                )}
                {action === "revoke" && (
                  <p className="text-sm">
                    Thu hồi không thể hoàn tác; client dùng key này sẽ không
                    truy cập được.
                  </p>
                )}
                {action === "pause" && (
                  <p className="text-sm">
                    Dừng truy cập toàn bộ kết nối và tắt quyền tạo đơn; giữ
                    nguyên key, dữ liệu và lịch sử.
                  </p>
                )}
                {error && (
                  <p role="alert" className="text-sm text-status-danger">
                    {error}
                  </p>
                )}
                {blocked && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setDialogOpen(false);
                      attempt.current = null;
                      setBlocked(false);
                      void refresh();
                    }}
                  >
                    Tải lại metadata
                  </Button>
                )}
              </>
            )}
          </McpDialog>
        </div>
      </Panel>
    </section>
  );
}
