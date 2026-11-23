import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Drawer, InlineError, PaginatedListFrame, localListPaginationMeta, StatusPill } from "@medusa-snus/ui";
import { useProducts } from "../hooks/useProducts";
import { useApplyOrderCorrection, usePreviewOrderCorrection, useOrderCorrectionFinancialContext } from "../hooks/useOrders";
import { createClientIdempotencyKey, type OrderCorrectionInput, type OrderListItem } from "../api/endpoints";
import { getClientScopeSnapshot, ApiError } from "../api/client";
import type { PaymentFeeInputV1 } from "@medusa-snus/contracts";
import { PaymentFeeAdjustmentInput } from "./CartPaymentFee";

type DraftItem = {
  variantId: string;
  name: string;
  sku: string;
  quantity: number;
  unitPrice: number;
};

function formatMoney(value: number | string | null | undefined) {
  return `${Number(value || 0).toLocaleString("vi-VN")} ₫`;
}

function draftFromOrder(order: OrderListItem): DraftItem[] {
  return (order.items || []).map((item) => ({
    variantId: String(item.variantId || ""),
    name: item.name,
    sku: "",
    quantity: Number(item.quantity || 0),
    unitPrice: Number(item.unitPrice || 0),
  })).filter((item) => item.variantId && item.quantity > 0);
}

function isExternalPayment(method: string | undefined) {
  return ["sepay_va", "nowpayments", "crypto_usdc", "crypto_usdt"].includes(String(method || ""));
}

export function OrderCorrectionDrawer({
  open,
  order,
  onClose,
}: {
  open: boolean;
  order: OrderListItem | null;
  onClose: () => void;
}) {
  const productsQuery = useProducts({ limit: 200 });
  const context = useOrderCorrectionFinancialContext(order?.id ?? null, open);
  const transport = { financial: context.financial, scope: context.scope };
  const preview = usePreviewOrderCorrection(transport);
  const apply = useApplyOrderCorrection(transport);
  const source = context.financial ? context.data?.data : undefined;
  const [draft, setDraft] = useState<DraftItem[]>([]);
  const [reason, setReason] = useState("");
  const [settlementMethod, setSettlementMethod] = useState("cash");
  const [shippingFee, setShippingFee] = useState("0");
  const [previewSignature, setPreviewSignature] = useState("");
  const [selectedVariant, setSelectedVariant] = useState("");
  const [draftPage, setDraftPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);
  const [paymentFee, setPaymentFee] = useState<Partial<PaymentFeeInputV1>>({});
  const [confirmationToken, setConfirmationToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{ input: OrderCorrectionInput; signature: string; key: string; confirmation: unknown } | null>(null);
  const [commandError, setCommandError] = useState("");
  const live = useRef({ partition: context.partition, orderId: order?.id, open });
  live.current = { partition: context.partition, orderId: order?.id, open };

  useEffect(() => {
    if (!order) return;
    setDraft(source ? source.items.map(line => ({ variantId: line.variantId ?? line.lineId, name: line.titleSnapshot,
      sku: line.skuSnapshot, quantity: line.quantity, unitPrice: line.unitPriceMinor })) : draftFromOrder(order));
    setReason("");
    setSettlementMethod(["cash", "bank_transfer", "cod"].includes(order.paymentMethod || "") ? order.paymentMethod || "cash" : "cash");
    setShippingFee(String(source?.components.shippingMinor ?? Number(order.shippingFee || 0)));
    setPaymentFee(source?.paymentFee ? { paymentFeeType: source.paymentFee.paymentFeeType, paymentFeeValue: source.paymentFee.paymentFeeValue } : {});
    setConfirmationToken(null); setAttempt(null); setCommandError("");
    setPreviewSignature("");
    setDraftPage(1);
    setHistoryPage(1);
    preview.reset();
    apply.reset();
  }, [order?.id, open, context.partition, context.financial, source?.baseRevision]);

  const variants = useMemo(() => (productsQuery.data || []).flatMap((product) =>
    (product.variants || []).map((variant) => ({
      variantId: variant.id,
      name: product.title,
      sku: variant.sku || "",
      unitPrice: Number(variant.prices?.[0]?.amount || 0),
      stock: Number(variant.inventory_quantity || 0),
    })),
  ).filter((variant) => variant.stock > 0), [productsQuery.data]);
  const draftPageMeta = localListPaginationMeta(draft.length, draftPage, 10);
  const visibleDraft = draft.slice((draftPageMeta.page - 1) * 10, draftPageMeta.page * 10);
  const correctionHistory = order?.corrections || [];
  const historyPageMeta = localListPaginationMeta(correctionHistory.length, historyPage, 10);
  const visibleCorrectionHistory = correctionHistory.slice((historyPageMeta.page - 1) * 10, historyPageMeta.page * 10);

  const contextBlocked = context.financial && (!context.scope ? "Chưa có phạm vi cửa hàng để điều chỉnh."
    : context.isError ? "Không tải được dữ liệu điều chỉnh hiện tại. Vui lòng tải lại."
      : !source || context.isFetching ? "Đang kiểm tra phiên bản và phụ phí đã lưu…"
        : source.commercialState === "cancelled" ? "Đơn đã hủy không thể điều chỉnh."
          : source.items.some(line => !line.variantId || line.archivedVariant)
            || new Set(source.items.map(line => line.variantId)).size !== source.items.length
            ? "Dòng hàng thiếu mapping hoặc không còn hoạt động; cần kiểm tra trước khi điều chỉnh." : "");
  const blockedReason = contextBlocked || (!order
    ? ""
    : order.status === "canceled"
      ? "Đơn đã hủy không thể điều chỉnh."
      : order.corrections?.some((correction) => correction.status !== "applied")
        ? "Đơn đang có điều chỉnh chưa hoàn tất."
        : order.paymentEntries?.some((entry) => (
          entry.direction === "refund"
          && entry.status === "posted"
          && entry.source !== "order_correction"
        ))
          ? "Đơn đã có hoàn tiền; hãy dùng quy trình hoàn tiền/đối soát."
          : isExternalPayment(order.paymentMethod)
            ? "Đơn thanh toán qua provider cần đối soát riêng trước khi điều chỉnh."
            : "");

  const baseRevision = source?.baseRevision ?? order?.correctionSummary?.latestRevision ?? 0;
  const readOnly = apply.isPending || Boolean(attempt);
  const input = useMemo<OrderCorrectionInput>(() => ({
    baseRevision,
    reason,
    items: draft.filter((item) => item.quantity > 0).map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
    shippingFee: Number(shippingFee || 0),
    ...(context.financial ? paymentFee : {}),
    settlement: {
      method: settlementMethod,
      amountReceived: Math.abs(Number(preview.data?.data.totalDelta || 0)),
    },
    ...(context.financial && confirmationToken ? { confirmationToken } : {}),
  }), [baseRevision, draft, preview.data?.data.totalDelta, reason, settlementMethod, shippingFee, context.financial, paymentFee, confirmationToken]);
  const inputSignature = JSON.stringify(input);

  function changeQuantity(variantId: string, quantity: number) {
    if (readOnly) return;
    setDraft((items) => items.map((item) => item.variantId === variantId ? { ...item, quantity: Math.max(0, quantity) } : item));
    setPreviewSignature("");
  }

  function addVariant() {
    if (readOnly) return;
    const variant = variants.find((entry) => entry.variantId === selectedVariant);
    if (!variant || draft.some((item) => item.variantId === variant.variantId)) return;
    setDraft((items) => [...items, { ...variant, quantity: 1 }]);
    setSelectedVariant("");
    setPreviewSignature("");
  }

  function previewCorrection() {
    if (!order || blockedReason || readOnly) return;
    const generation = { ...live.current }, scope = context.scope;
    const current = () => live.current.open && live.current.orderId === generation.orderId && live.current.partition === generation.partition
      && (!context.financial || (getClientScopeSnapshot().operatingMerchantId === scope?.merchantId && getClientScopeSnapshot().operatingStoreId === scope?.storeId));
    preview.mutate({ orderId: order.id, input }, {
      onSuccess: (result) => {
        if (!current()) return;
        const token = "schemaVersion" in result ? result.data.confirmationToken : undefined;
        setConfirmationToken(token ?? null);
        // Preview is the authority for the exact settlement amount. Store the
        // signature of the post-quote command so one review is sufficient.
        setPreviewSignature(JSON.stringify({
          ...input,
          ...(token ? { confirmationToken: token } : {}),
          settlement: {
            ...input.settlement,
            amountReceived: Math.abs(Number(result.data.totalDelta || 0)),
          },
        }));
      },
    });
  }

  function applyCorrection() {
    if (!order || blockedReason || previewSignature !== inputSignature) return;
    if (apply.isPending) return;
    const generation = { ...live.current }, scope = context.scope;
    const current = () => live.current.open && live.current.orderId === generation.orderId && live.current.partition === generation.partition
      && (!context.financial || (getClientScopeSnapshot().operatingMerchantId === scope?.merchantId && getClientScopeSnapshot().operatingStoreId === scope?.storeId));
    const confirmed = context.financial ? attempt ?? { input: structuredClone(input), signature: inputSignature,
      key: createClientIdempotencyKey("order-correction"), confirmation: preview.data } : null;
    if (confirmed && confirmed.signature !== inputSignature) { setCommandError("Yêu cầu trước chưa xác định kết quả. Giữ nguyên nội dung để thử lại."); return; }
    setAttempt(confirmed); setCommandError("");
    apply.mutate({ orderId: order.id, input: confirmed?.input ?? input, ...(confirmed ? { intentKey: confirmed.key, confirmation: confirmed.confirmation } : {}) }, {
      onSuccess: () => { if (current()) onClose(); },
      onError: error => {
        if (!current()) return;
        if (error instanceof ApiError && ["validation_error", "order_correction_conflict", "order_correction_quote_changed", "insufficient_stock", "payment_settlement_required"].includes(error.code ?? "")) {
          setAttempt(null); setPreviewSignature(""); setConfirmationToken(null);
        }
      },
    });
  }

  const quoted = previewSignature === inputSignature ? preview.data?.data : undefined;
  const quotedFinancial = quoted && preview.data && "schemaVersion" in preview.data ? preview.data.data : undefined;
  const needsSettlement = Number(quoted?.totalDelta || 0) !== 0;
  const canApply = Boolean(
    quoted
    && previewSignature === inputSignature
    && !blockedReason
    && !preview.isPending
    && !apply.isPending,
  );

  return (
    <Drawer
      open={open && !!order}
      title={`Điều chỉnh đơn ${order?.display_id || ""}`}
      subtitle="Lịch sử đơn gốc giữ nguyên. Hệ thống sẽ ghi nhận một phiên điều chỉnh mới."
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>Hủy</Button>
          <Button variant="primary" onClick={applyCorrection} disabled={!canApply}>
            {apply.isPending ? "Đang xác nhận..." : "Xác nhận điều chỉnh"}
          </Button>
        </>
      }
    >
      {context.financial && context.isError && <InlineError message="Không tải được dữ liệu điều chỉnh hiện tại." onRetry={() => void context.refetch()} />}
      {order && (
        <fieldset disabled={readOnly || Boolean(contextBlocked)} className="space-y-4 text-sm">
          {blockedReason && (
            <div className="rounded-md border border-status-warning-border bg-status-warning-bg p-3 text-status-warning">
              {blockedReason}
            </div>
          )}

          <div className="rounded-md border border-border-default bg-surface-subtle p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-text-muted">Phiên bản hiện tại</span>
              <StatusPill tone="info" label={`#${baseRevision}`} />
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-xs text-text-muted">Tổng đơn hiện tại</span>
              <strong className="tabular-nums text-text-primary">{formatMoney(source?.components.totalMinor ?? order.total)}</strong>
            </div>
          </div>

          {context.financial && source && <PaymentFeeAdjustmentInput adjustment={{ discountType: "amount", discountValue: source.components.discountMinor,
            shippingFee: Number(shippingFee || 0), ...paymentFee }} disabled={readOnly}
            onChange={value => { if (readOnly) return; setPaymentFee({ paymentFeeType: value.paymentFeeType, paymentFeeValue: value.paymentFeeValue }); setPreviewSignature(""); }} />}
          {context.financial && source?.paymentFee && <p className="text-xs text-text-secondary">Phụ phí đã lưu: {source.paymentFee.paymentFeeValue}{source.paymentFee.paymentFeeType === "percent" ? "%" : " ₫"} · {formatMoney(source.components.paymentFeeMinor)}</p>}

          <section className="rounded-md border border-border-default bg-surface-panel">
            <div className="border-b border-border-subtle px-3 py-2 text-xs font-medium text-text-secondary">Hàng sau điều chỉnh</div>
            <PaginatedListFrame
              label="Phân trang dòng điều chỉnh"
              rowNoun="sản phẩm"
              meta={draftPageMeta}
              onPageChange={setDraftPage}
            >
              <div className="divide-y divide-border-subtle">
                {visibleDraft.map((item) => (
                  <div key={item.variantId} className="grid grid-cols-[minmax(0,1fr)_88px] gap-3 px-3 py-3">
                    <div className="min-w-0">
                      <p className="break-words font-medium text-text-primary">{item.name}</p>
                      <p className="mt-0.5 truncate font-mono text-xs text-text-muted">
                        {item.sku || item.variantId}
                      </p>
                      <p className="mt-1 text-xs text-text-secondary">
                        {formatMoney(item.unitPrice)} / đơn vị
                      </p>
                    </div>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Giảm ${item.name}`}
                        onClick={() => changeQuantity(item.variantId, item.quantity - 1)}
                      >
                        -
                      </Button>
                      <input
                        className="h-8 w-9 rounded-md border border-border-default bg-surface-panel text-center text-sm tabular-nums focus:border-action-primary focus:outline-none"
                        aria-label={`Số lượng ${item.name}`}
                        type="number"
                        min={0}
                        max={99}
                        value={item.quantity}
                        onChange={(event) => changeQuantity(item.variantId, Number(event.target.value || 0))}
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Tăng ${item.name}`}
                        onClick={() => changeQuantity(item.variantId, item.quantity + 1)}
                      >
                        +
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </PaginatedListFrame>
            <div className="border-t border-border-subtle p-3">
              <label className="mb-1 block text-xs text-text-muted">Thêm sản phẩm</label>
              <div className="flex gap-2">
                <select
                  aria-label="Thêm sản phẩm vào điều chỉnh đơn"
                  value={selectedVariant}
                  onChange={(event) => setSelectedVariant(event.target.value)}
                  className="h-9 min-w-0 flex-1 rounded-md border border-border-default bg-surface-panel px-2 text-xs focus:border-action-primary focus:outline-none"
                >
                  <option value="">Chọn sản phẩm</option>
                  {variants.filter((variant) => !draft.some((item) => item.variantId === variant.variantId)).map((variant) => (
                    <option key={variant.variantId} value={variant.variantId}>{variant.name} · {variant.sku}</option>
                  ))}
                </select>
                <Button size="sm" variant="secondary" onClick={addVariant} disabled={!selectedVariant}>Thêm</Button>
              </div>
            </div>
          </section>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Phí vận chuyển sau điều chỉnh</label>
            <input
              value={shippingFee}
              onChange={(event) => {
                setShippingFee(event.target.value.replace(/[^0-9]/g, ""));
                setPreviewSignature("");
              }}
              inputMode="numeric"
              className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm tabular-nums focus:border-action-primary focus:outline-none"
              aria-label="Phí vận chuyển sau điều chỉnh"
            />
            <p className="mt-1 text-xs text-text-muted">Giá trị cuối cùng của đơn; tăng/giảm được đưa vào cùng phiên điều chỉnh.</p>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Lý do điều chỉnh</label>
            <textarea
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setPreviewSignature("");
              }}
              rows={3}
              minLength={10}
              maxLength={500}
              className="w-full resize-none rounded-md border border-border-default bg-surface-panel px-3 py-2 text-sm focus:border-action-primary focus:outline-none"
              placeholder="Nêu rõ hàng hoặc số lượng đã nhập nhầm."
            />
            <p className="mt-1 text-xs text-text-muted">{reason.length}/500, tối thiểu 10 ký tự.</p>
          </div>

          <div className="rounded-md border border-border-default bg-surface-subtle p-3">
            <div className="mb-2 text-xs font-medium text-text-secondary">Đối soát chênh lệch</div>
            <label className="mb-1 block text-xs text-text-muted">Phương thức thu/hoàn</label>
            <select
              value={settlementMethod}
              onChange={(event) => {
                setSettlementMethod(event.target.value);
                setPreviewSignature("");
              }}
              className="h-9 w-full rounded-md border border-border-default bg-surface-panel px-2 text-sm focus:border-action-primary focus:outline-none"
            >
              <option value="cash">Tiền mặt</option>
              <option value="bank_transfer">Chuyển khoản</option>
              <option value="cod">COD</option>
            </select>
            {quoted && (
              <div className="mt-3 space-y-1 text-xs">
                {quotedFinancial?.afterFinancial.status === "available" && <>
                  <div className="flex justify-between gap-3"><span>Phụ phí sau điều chỉnh</span><b>{formatMoney(quotedFinancial.afterFinancial.snapshot.components.paymentFeeMinor)}</b></div>
                  <div className="flex justify-between gap-3"><span>{quotedFinancial.afterFinancial.snapshot.components.taxMode === "inclusive" ? "VAT đã gồm" : "VAT cộng thêm"}</span><b>{formatMoney(quotedFinancial.afterFinancial.snapshot.components.vatMinor)}</b></div>
                </>}
                <div className="flex justify-between gap-3"><span>Tổng mới</span><b className="tabular-nums">{formatMoney(quoted.afterTotals.total)}</b></div>
                <div className="flex justify-between gap-3"><span>Chênh lệch</span><b className={quoted.totalDelta >= 0 ? "tabular-nums text-status-success" : "tabular-nums text-status-danger"}>{quoted.totalDelta >= 0 ? "+" : ""}{formatMoney(quoted.totalDelta)}</b></div>
                <p className="pt-1 text-text-secondary">
                  {quoted.settlement.direction === "collect"
                    ? `Cần thu đúng ${formatMoney(quoted.settlement.amount)}.`
                    : quoted.settlement.direction === "refund"
                      ? `Cần hoàn đúng ${formatMoney(quoted.settlement.amount)}.`
                      : "Không phát sinh thu hoặc hoàn tiền."}
                </p>
              </div>
            )}
          </div>

          <Button variant="secondary" className="w-full" onClick={previewCorrection} disabled={readOnly || Boolean(blockedReason) || preview.isPending || reason.trim().length < 10 || draft.every((item) => item.quantity <= 0)}>
            {preview.isPending ? "Đang tính chênh lệch..." : "Xem chênh lệch"}
          </Button>
          {preview.error && <InlineError message={preview.error instanceof Error ? preview.error.message : "Không thể tính điều chỉnh đơn."} onRetry={previewCorrection} />}
          {apply.error && <InlineError message={apply.error instanceof Error ? apply.error.message : "Không thể áp dụng điều chỉnh đơn."} onRetry={applyCorrection} />}
          {attempt && !apply.isPending && <p role="status" className="text-xs text-status-warning">Chưa xác định được kết quả. Thử lại với đúng nội dung và mã xác nhận đang giữ; không tạo yêu cầu mới.</p>}
          {commandError && <InlineError message={commandError} />}
          {order.corrections && order.corrections.length > 0 && (
            <section className="rounded-md border border-border-default bg-surface-panel">
              <div className="border-b border-border-subtle px-3 py-2 text-xs font-medium text-text-secondary">Lịch sử điều chỉnh</div>
              <PaginatedListFrame
                label="Phân trang lịch sử điều chỉnh"
                rowNoun="điều chỉnh"
                meta={historyPageMeta}
                onPageChange={setHistoryPage}
              >
                <div className="divide-y divide-border-subtle">
                  {visibleCorrectionHistory.map((correction) => (
                    <div key={correction.id} className="px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-3">
                        <b>Điều chỉnh #{correction.revision}</b>
                        <span className="tabular-nums">
                          {correction.totalDelta >= 0 ? "+" : ""}
                          {formatMoney(correction.totalDelta)}
                        </span>
                      </div>
                      <p className="mt-1 text-text-secondary">{correction.reason}</p>
                    </div>
                  ))}
                </div>
              </PaginatedListFrame>
            </section>
          )}

          {needsSettlement && previewSignature !== inputSignature && (
            <p className="text-xs text-status-warning">Dữ liệu đã thay đổi; hãy xem lại chênh lệch trước khi xác nhận.</p>
          )}
        </fieldset>
      )}
    </Drawer>
  );
}
