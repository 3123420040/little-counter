import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button, Drawer, InlineError, PaginatedListFrame, loadedListPaginationMeta, localListPaginationMeta, MutationBanner,
  OperationalTable, PageHeader, Panel, StatusPill, TableSkeleton,
} from "@medusa-snus/ui";
import { useCreatePurchaseOrder, usePurchaseOrderCatalog, usePurchaseOrders } from "../hooks/useInventory";
import {
  createClientIdempotencyKey,
  downloadPurchaseOrderRecommendationCsv,
  type PurchaseOrderListItem,
} from "../api/endpoints";
import { Eye, FileSpreadsheet, Package, Plus, Trash2, Upload } from "lucide-react";
import { useI18n } from "../i18n";
import { ExportTemplateActions } from "../components/ExportTemplateActions";
import { ImportDialog } from "../components/ImportDialog";

type Notice = { tone: "success" | "error" | "pending"; message: string };
type DraftLine = {
  clientId: string;
  variantId: string;
  quantity: string;
  unitCost: string;
  costQuality: "unknown" | "known" | "free";
};

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  received: "success",
  partially_received: "warning",
  sent: "info",
  draft: "warning",
  cancelled: "danger",
  closed_short: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Nháp",
  sent: "Đã gửi NCC",
  partially_received: "Nhận một phần",
  received: "Đã nhận đủ",
  cancelled: "Đã hủy",
  closed_short: "Đóng thiếu",
};

function formatVnd(amount?: number | null) {
  return `${Number(amount || 0).toLocaleString("vi-VN")} ₫`;
}

function formatQty(amount?: number | null) {
  return Number(amount || 0).toLocaleString("vi-VN");
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
}

function toIsoDateTime(value: string) {
  if (!value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function newDraftLine(clientId = `line_${Date.now()}`): DraftLine {
  return { clientId, variantId: "", quantity: "20", unitCost: "", costQuality: "unknown" };
}

export default function PurchaseOrderScreen() {
  const LIST_PAGE_SIZE = 20;
  const DRAFT_PAGE_SIZE = 10;
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data: posData, isLoading, error, refetch } = usePurchaseOrders();
  const createMutation = useCreatePurchaseOrder();

  const [showCreate, setShowCreate] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [supplierName, setSupplierName] = useState("");
  const [expectedAt, setExpectedAt] = useState("");
  const [draftLines, setDraftLines] = useState<DraftLine[]>(() => [newDraftLine("line_1")]);
  const [lineSequence, setLineSequence] = useState(2);
  const [recommendationPending, setRecommendationPending] = useState(false);
  const [mutationNotice, setMutationNotice] = useState<Notice | null>(null);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogOffset, setCatalogOffset] = useState(0);
  const [purchaseOrdersPage, setPurchaseOrdersPage] = useState(1);
  const [draftLinesPage, setDraftLinesPage] = useState(1);
  const [createSubmitError, setCreateSubmitError] = useState<string | null>(null);
  const createIntentKeyRef = useRef<string | null>(null);

  const selectedVariantIds = useMemo(
    () => draftLines.map((line) => line.variantId).filter(Boolean),
    [draftLines],
  );
  const { data: catalog, isLoading: catalogLoading, error: catalogError } = usePurchaseOrderCatalog({
    q: catalogSearch,
    limit: 25,
    offset: catalogOffset,
    selectedVariantIds,
  });

  const pos = (posData?.data || []) as PurchaseOrderListItem[];
  const purchaseOrdersMeta = loadedListPaginationMeta(pos.length, purchaseOrdersPage, LIST_PAGE_SIZE);
  const visiblePurchaseOrders = pos.slice(
    (purchaseOrdersMeta.page - 1) * LIST_PAGE_SIZE,
    purchaseOrdersMeta.page * LIST_PAGE_SIZE,
  );
  const draftLinesMeta = localListPaginationMeta(draftLines.length, draftLinesPage, DRAFT_PAGE_SIZE);
  const visibleDraftLines = draftLines.slice(
    (draftLinesMeta.page - 1) * DRAFT_PAGE_SIZE,
    draftLinesMeta.page * DRAFT_PAGE_SIZE,
  );
  const catalogLimit = catalog?.page.limit || 25;
  const catalogMeta = localListPaginationMeta(
    catalog?.page.total || 0,
    Math.floor(catalogOffset / catalogLimit) + 1,
    catalogLimit,
  );

  useEffect(() => {
    if (catalog && !catalogError && catalogOffset !== (catalogMeta.page - 1) * catalogLimit) {
      setCatalogOffset((catalogMeta.page - 1) * catalogLimit);
    }
  }, [catalog, catalogError, catalogLimit, catalogMeta.page, catalogOffset]);

  useEffect(() => {
    setCatalogOffset(0);
  }, [catalogSearch]);

  const variantOptions = useMemo(() => (
    (catalog?.data || []).map((item) => ({
      id: item.variantId,
      sku: item.sku || item.variantId,
      label: `${item.productName} · ${item.sku || item.variantId}`,
      categories: item.categoryNames.join(", "),
      defaultUnitCost: item.defaultUnitCost,
      defaultUnitCostQuality: item.defaultUnitCostQuality,
    }))
  ), [catalog]);

  function updateLine(clientId: string, patch: Partial<DraftLine>) {
    setDraftLines((current) => current.map((line) => line.clientId === clientId ? { ...line, ...patch } : line));
  }

  function addLine() {
    setDraftLinesPage(Math.floor(draftLines.length / DRAFT_PAGE_SIZE) + 1);
    setDraftLines((current) => [
      ...current,
      newDraftLine(`line_${lineSequence}`),
    ]);
    setLineSequence((current) => current + 1);
  }

  function removeLine(clientId: string) {
    setDraftLines((current) => current.length === 1 ? current : current.filter((line) => line.clientId !== clientId));
  }

  function openCreateDrawer() {
    createIntentKeyRef.current = createClientIdempotencyKey("po-create");
    setCreateSubmitError(null);
    setMutationNotice(null);
    setShowCreate(true);
  }

  function abandonCreateIntent() {
    if (createMutation.isPending) return;
    createIntentKeyRef.current = null;
    setCreateSubmitError(null);
    setShowCreate(false);
  }

  const createError = useMemo(() => {
    if (!supplierName.trim()) return "Nhập tên nhà cung cấp.";
    if (draftLines.length === 0) return "Đơn cần ít nhất một SKU.";
    const variantIds = new Set<string>();
    for (const line of draftLines) {
      if (!line.variantId) return "Chọn sản phẩm cho từng dòng.";
      if (variantIds.has(line.variantId)) return "Một SKU chỉ được xuất hiện một lần trong đơn.";
      variantIds.add(line.variantId);
      if (!Number.isInteger(Number(line.quantity)) || Number(line.quantity) <= 0) return "Số lượng đặt phải là số nguyên dương.";
      if (line.costQuality === "unknown" || !line.unitCost.trim()) return "Nhập đơn giá hoặc xác nhận SKU miễn phí; không được coi giá chưa biết là 0.";
      if (!Number.isInteger(Number(line.unitCost)) || Number(line.unitCost) < 0) return "Đơn giá nhập phải là số nguyên không âm.";
      if (Number(line.unitCost) === 0 && line.costQuality !== "free") return "Giá 0 cần được xác nhận là miễn phí.";
    }
    return "";
  }, [draftLines, supplierName]);

  async function handleCreate() {
    if (createError) return;
    const intentKey = createIntentKeyRef.current || createClientIdempotencyKey("po-create");
    createIntentKeyRef.current = intentKey;
    setCreateSubmitError(null);
    try {
      await createMutation.mutateAsync({
        intentKey,
        data: {
          supplierName: supplierName.trim(),
          expectedDate: toIsoDateTime(expectedAt),
          items: draftLines.map((line) => ({
            variantId: line.variantId,
            quantity: Number(line.quantity),
            unitCost: Number(line.unitCost),
            unitCostQuality: line.costQuality === "free" ? "free" as const : "known" as const,
          })),
        },
      });
      setMutationNotice({ tone: "success", message: "Đã tạo đơn đặt hàng." });
      createIntentKeyRef.current = null;
      setShowCreate(false);
      setSupplierName("");
      setExpectedAt("");
      setDraftLines([newDraftLine("line_1")]);
      setLineSequence(2);
    } catch (err) {
      setCreateSubmitError(err instanceof Error ? err.message : "Không thể tạo đơn đặt hàng.");
    }
  }

  async function handleDownloadRecommendation() {
    setRecommendationPending(true);
    setMutationNotice({ tone: "pending", message: "Đang tạo file đề xuất đặt hàng..." });
    try {
      await downloadPurchaseOrderRecommendationCsv({ coverageDays: 30, includeZeroSuggestion: false });
      setMutationNotice({ tone: "success", message: "Đã tải file đề xuất đặt hàng." });
    } catch (err) {
      setMutationNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể tải file đề xuất.",
      });
    } finally {
      setRecommendationPending(false);
    }
  }

  if (error) {
    return (
      <div className="p-4">
        <InlineError message="Không thể tải đơn đặt hàng" onRetry={() => refetch()} stale />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title={t("po.title")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="md"
              icon={<FileSpreadsheet size={15} aria-hidden="true" />}
              disabled={recommendationPending}
              onClick={() => void handleDownloadRecommendation()}
            >
              {recommendationPending ? "Đang tạo..." : "Đề xuất đặt hàng"}
            </Button>
            <ExportTemplateActions
              resource="purchaseOrders"
              exportLabel="Xuất danh sách PO"
              templateLabel="Tải mẫu nhập PO"
              onError={(downloadError) => setMutationNotice({ tone: "error", message: downloadError.message })}
            />
            <Button
              variant="secondary"
              size="md"
              icon={<Upload size={15} aria-hidden="true" />}
              onClick={() => setImportOpen(true)}
            >
              Nhập CSV
            </Button>
            <Button
              variant="primary"
              size="md"
              icon={<Plus size={15} aria-hidden="true" />}
              onClick={openCreateDrawer}
            >
              {t("po.create")}
            </Button>
          </div>
        }
      />

      {mutationNotice && (
        <MutationBanner
          tone={mutationNotice.tone}
          message={mutationNotice.message}
          actionLabel={mutationNotice.tone === "error" ? t("state.close") : undefined}
          onAction={() => setMutationNotice(null)}
        />
      )}

      <Panel title="Danh sách">
        {isLoading ? (
          <TableSkeleton rows={5} cols={6} />
        ) : pos.length === 0 ? (
          <div className="p-6 text-center">
            <Package size={32} className="text-text-muted mb-3 mx-auto" />
            <p className="text-sm text-text-muted">{t("po.emptyOrders")}</p>
            <Button variant="primary" className="mt-3" onClick={openCreateDrawer}>
              {t("po.createFirst")}
            </Button>
          </div>
        ) : (
          <>
          <PaginatedListFrame
            label="Phân trang đơn đặt hàng"
            rowNoun="đơn đặt hàng"
            meta={purchaseOrdersMeta}
            onPageChange={setPurchaseOrdersPage}
          >
            <OperationalTable
              ariaLabel="Danh sách đơn đặt hàng"
              minWidth={920}
              onRowClick={(_row, index) => {
                const order = typeof index === "number" ? visiblePurchaseOrders[index] : null;
                if (order) navigate(`/purchase-orders/${encodeURIComponent(order.id)}`);
              }}
              columns={[
                { key: "supplier", label: t("po.supplier") },
                { key: "created", label: "Ngày tạo" },
                { key: "items", label: t("po.items") },
                { key: "progress", label: "Đã nhận / đặt", align: "right" },
                { key: "total", label: t("po.total"), align: "right" },
                { key: "status", label: "Trạng thái" },
                { key: "actions", label: "", align: "right" },
              ]}
              rows={visiblePurchaseOrders.map((p) => {
                const orderedQuantity =
                  p.orderedQuantity ?? p.items.reduce((sum, item) => sum + item.quantity, 0);
                const receivedQuantity =
                  p.receivedQuantity ?? p.items.reduce((sum, item) => sum + item.receivedQuantity, 0);
                const total =
                  p.totalCostAvailable === false
                    ? null
                    : (p.totalCost ??
                      p.items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0));
                return {
                  supplier: (
                    <div className="min-w-0">
                      <span className="block font-medium text-text-primary">{p.supplierName}</span>
                      <span className="block text-xs text-text-muted">{p.id}</span>
                    </div>
                  ),
                  created: (
                    <span className="text-sm text-text-secondary">{formatDateTime(p.createdAt)}</span>
                  ),
                  items: `${p.lineCount ?? p.items.length} SKU`,
                  progress: (
                    <span className="tabular-nums">
                      {formatQty(receivedQuantity)} / {formatQty(orderedQuantity)}
                    </span>
                  ),
                  total: (
                    <span className="tabular-nums">
                      {p.totalCostAvailable === false || total === null
                        ? "Không khả dụng"
                        : formatVnd(total)}
                    </span>
                  ),
                  status: (
                    <StatusPill
                      tone={STATUS_TONE[p.status] || "info"}
                      label={STATUS_LABEL[p.status] || p.status}
                    />
                  ),
                  actions: (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Eye size={14} aria-hidden="true" />}
                      onClick={(event) => {
                        event.stopPropagation();
                        navigate(`/purchase-orders/${encodeURIComponent(p.id)}`);
                      }}
                    >
                      Chi tiết
                    </Button>
                  ),
                };
              })}
            />
          </PaginatedListFrame>
          </>
        )}
      </Panel>

      <Drawer
        open={showCreate}
        title={t("po.createTitle")}
        size="wide"
        onClose={abandonCreateIntent}
        actions={
          <>
            <Button
              variant="primary"
              onClick={handleCreate}
              disabled={!!createError || createMutation.isPending}
            >
              {createMutation.isPending ? t("state.loading") : t("state.confirm")}
            </Button>
            <Button
              variant="secondary"
              disabled={createMutation.isPending}
              onClick={abandonCreateIntent}
            >
              {t("state.cancel")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createSubmitError && (
            <InlineError
              message={`${createSubmitError} Dữ liệu nhập và mã retry được giữ nguyên; hãy thử lại hoặc hủy để bắt đầu intent mới.`}
            />
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label htmlFor="po-supplier-name" className="mb-1 block text-xs font-medium text-text-secondary">
                {t("po.supplier")}
              </label>
              <input
                id="po-supplier-name"
                placeholder="Nhập tên nhà cung cấp"
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm
                           focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
              />
            </div>
            <div>
              <label htmlFor="po-expected-at" className="mb-1 block text-xs font-medium text-text-secondary">
                Thời gian dự kiến
              </label>
              <input
                id="po-expected-at"
                type="datetime-local"
                value={expectedAt}
                onChange={(e) => setExpectedAt(e.target.value)}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm
                           focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-text-primary">Sản phẩm đặt</h3>
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus size={14} aria-hidden="true" />}
                onClick={addLine}
                disabled={variantOptions.length === 0}
              >
                Thêm SKU
              </Button>
            </div>
            <PaginatedListFrame
              label="Phân trang catalog đặt hàng"
              rowNoun="biến thể"
              meta={catalogMeta}
              busy={catalogLoading}
              showPagination={!catalogError}
              onPageChange={(nextPage) => setCatalogOffset((nextPage - 1) * catalogLimit)}
              className="rounded-lg border border-border-default bg-surface-subtle"
              bodyClassName="p-3"
            >
              {catalogError && (
                <p role="alert" className="text-xs text-status-danger">
                  Không thể tải catalog. Các dòng đã chọn được giữ nguyên.
                </p>
              )}
              <div className="min-w-[240px] flex-1">
                <label
                  htmlFor="po-catalog-search"
                  className="mb-1 block text-xs font-medium text-text-secondary"
                >
                  Tìm toàn bộ catalog
                </label>
                <input
                  id="po-catalog-search"
                  value={catalogSearch}
                  onChange={(event) => {
                    setCatalogSearch(event.target.value);
                    setCatalogOffset(0);
                  }}
                  placeholder="Tên sản phẩm, SKU, barcode hoặc danh mục"
                  className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm
                                       focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                />
              </div>

              <PaginatedListFrame
                label="Phân trang dòng nháp đơn đặt hàng"
                rowNoun="dòng SKU"
                meta={draftLinesMeta}
                onPageChange={setDraftLinesPage}
              >
                <div className="space-y-2">
                  {visibleDraftLines.map((line, index) => (
                    <div
                      key={line.clientId}
                      className="grid grid-cols-1 gap-2 rounded-lg border border-border-default bg-surface-panel p-3 md:grid-cols-[minmax(0,1fr)_120px_140px_36px]"
                    >
                      <div>
                        <label
                          htmlFor={`po-variant-${line.clientId}`}
                          className="mb-1 block text-xs font-medium text-text-secondary"
                        >
                          SKU {(draftLinesMeta.page - 1) * DRAFT_PAGE_SIZE + index + 1}
                        </label>
                        <select
                          id={`po-variant-${line.clientId}`}
                          value={line.variantId}
                          onChange={(e) => {
                            const option = variantOptions.find(
                              (candidate) => candidate.id === e.target.value,
                            );
                            updateLine(line.clientId, {
                              variantId: e.target.value,
                              unitCost:
                                option?.defaultUnitCostQuality === "known" &&
                                Number(option.defaultUnitCost) > 0
                                  ? String(option.defaultUnitCost)
                                  : "",
                              costQuality: option?.defaultUnitCostQuality === "known" ? "known" : "unknown",
                            });
                          }}
                          className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm
                                           focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                        >
                          <option value="">Chọn một SKU...</option>
                          {variantOptions.length === 0 ? (
                            <option value="">Chưa tải được danh sách sản phẩm</option>
                          ) : (
                            variantOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.categories ? `${option.label} · ${option.categories}` : option.label}
                              </option>
                            ))
                          )}
                        </select>
                      </div>
                      <div>
                        <label
                          htmlFor={`po-quantity-${line.clientId}`}
                          className="mb-1 block text-xs font-medium text-text-secondary"
                        >
                          Số lượng
                        </label>
                        <input
                          id={`po-quantity-${line.clientId}`}
                          type="number"
                          min={1}
                          step={1}
                          value={line.quantity}
                          onChange={(e) => updateLine(line.clientId, { quantity: e.target.value })}
                          className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm tabular-nums
                                           focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor={`po-unit-cost-${line.clientId}`}
                          className="mb-1 block text-xs font-medium text-text-secondary"
                        >
                          Đơn giá nhập
                        </label>
                        <input
                          id={`po-unit-cost-${line.clientId}`}
                          type="number"
                          min={0}
                          step={1000}
                          value={line.unitCost}
                          onChange={(e) => {
                            const next = e.target.value;
                            updateLine(line.clientId, {
                              unitCost: next,
                              costQuality: next.trim() && Number(next) > 0 ? "known" : "unknown",
                            });
                          }}
                          className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm tabular-nums
                                           focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                        />
                        <label className="mt-1 flex items-center gap-2 text-xs text-text-secondary">
                          <input
                            type="checkbox"
                            checked={line.costQuality === "free"}
                            onChange={(event) =>
                              updateLine(
                                line.clientId,
                                event.target.checked
                                  ? { unitCost: "0", costQuality: "free" }
                                  : { unitCost: "", costQuality: "unknown" },
                              )
                            }
                          />
                          Miễn phí / giá 0 đã xác nhận
                        </label>
                      </div>
                      <div className="flex items-end">
                        <Button
                          variant="ghost"
                          size="md"
                          icon={<Trash2 size={15} aria-hidden="true" />}
                          aria-label="Xóa dòng SKU"
                          disabled={draftLines.length === 1}
                          onClick={() => removeLine(line.clientId)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </PaginatedListFrame>
            </PaginatedListFrame>
          </div>

          {createError && (
            <div className="rounded-md border border-status-warning-border bg-status-warning-bg px-3 py-2 text-sm text-status-warning">
              {createError}
            </div>
          )}
        </div>
      </Drawer>

      <ImportDialog
        open={importOpen}
        resource="purchaseOrders"
        onClose={() => setImportOpen(false)}
        onSuccess={() => void refetch()}
      />
    </div>
  );
}
