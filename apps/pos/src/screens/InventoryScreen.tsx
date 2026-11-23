import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Badge, Button, Drawer, FilterBar, InlineError, MetricCell,
  PaginatedListFrame, localListPaginationMeta, MutationBanner, OperationalTable, PageHeader, Panel,
  ResponsiveMetricGrid, SearchBox, TableSkeleton,
} from "@medusa-snus/ui";
import { useInventoryAlerts, useInventoryData, useAdjustStock } from "../hooks/useInventory";
import { useProductCategories } from "../hooks/useProductCategories";
import { History, Package, QrCode, SlidersHorizontal, Upload } from "lucide-react";
import { acknowledgeAiAlert, type ProductScanResolution } from "../api/endpoints";
import { StockMovementLog } from "../components/StockMovementLog";
import { StockHistoryDrawer } from "../components/StockHistoryDrawer";
import { useI18n } from "../i18n";
import { ExportTemplateActions } from "../components/ExportTemplateActions";
import { ImportDialog } from "../components/ImportDialog";
import { StaffScanDialog } from "../components/StaffScanDialog";
import type { InventoryItem } from "../api/client";

function normalizeSearchTerm(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

export default function InventoryScreen() {
  const PAGE_SIZE = 20;
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data: items, isLoading, error, refetch } = useInventoryData();
  const [showAdjust, setShowAdjust] = useState(false);
  const [inventoryScanOpen, setInventoryScanOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<{ id: string; title: string; currentStock: number } | null>(null);
  const [historyItem, setHistoryItem] = useState<InventoryItem | null>(null);
  const [countedStock, setCountedStock] = useState("");
  const [adjustReason, setAdjustReason] = useState("cycle_count");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const requestedStock = searchParams.get("stock");
  const requestedSearch = searchParams.get("q") || "";
  const requestedHistory = searchParams.get("history") || "";
  const [stockFilter, setStockFilter] = useState<"all" | "in_stock" | "low" | "out">(
    requestedStock === "in_stock" || requestedStock === "low" || requestedStock === "out" ? requestedStock : "all",
  );
  const [categoryId, setCategoryId] = useState("all");
  const [mutationNotice, setMutationNotice] = useState<{ tone: "success" | "error" | "pending"; message: string } | null>(null);
  const adjustMutation = useAdjustStock();
  const { data: categoriesData } = useProductCategories({ status: "active", includeProductCounts: false });
  const categories = categoriesData?.product_categories || [];

  const { data: aiAlertsData } = useInventoryAlerts();
  const aiAlerts = (aiAlertsData?.data || []) as Array<{
    id: string; productId: string; variantId?: string | null; inventoryItemId?: string | null; productTitle?: string; sku?: string | null; currentStock: number; reorderLevel: number; suggestedQuantity: number; status: string; createdAt: string;
  }>;

  const total = items?.length ?? 0;
  const statusFor = (item: NonNullable<typeof items>[number]) => {
    const qty = item.location_levels?.[0]?.stocked_quantity ?? 0;
    const reorderLevel = Math.max(1, Number(item.reorder_level || 5));
    if (qty === 0) return "out" as const;
    if (qty <= reorderLevel) return "low" as const;
    return "in_stock" as const;
  };
  const setFilter = (next: typeof stockFilter) => {
    setStockFilter(next);
    const params = new URLSearchParams(searchParams);
    if (next === "all") params.delete("stock");
    else params.set("stock", next);
    navigate({ pathname: "/inventory", search: params.toString() ? `?${params.toString()}` : "" });
  };
  const clearFilters = () => {
    setSearch("");
    setCategoryId("all");
    setStockFilter("all");
    const params = new URLSearchParams(searchParams);
    params.delete("q");
    params.delete("stock");
    navigate({ pathname: "/inventory", search: params.toString() ? `?${params.toString()}` : "" });
  };
  useEffect(() => {
    setStockFilter(requestedStock === "in_stock" || requestedStock === "low" || requestedStock === "out" ? requestedStock : "all");
  }, [requestedStock]);
  useEffect(() => {
    setSearch(requestedSearch);
  }, [requestedSearch]);
  useEffect(() => {
    const requestedItem = searchParams.get("item");
    if (!requestedItem || !items) return;
    const item = items.find((entry) => entry.id === requestedItem);
    if (!item) return;
    const qty = item.location_levels?.[0]?.stocked_quantity ?? 0;
    setSelectedItem({ id: item.id, title: item.title || item.sku || "", currentStock: qty });
    setCountedStock(String(qty));
    setAdjustReason("cycle_count");
    setShowAdjust(true);
  }, [items, searchParams]);
  useEffect(() => {
    if (!requestedHistory) {
      if (historyItem) setHistoryItem(null);
      return;
    }
    if (!items) return;
    const item = items.find((entry) => entry.id === requestedHistory || entry.product_id === requestedHistory);
    if (item && historyItem?.id !== item.id) setHistoryItem(item);
  }, [historyItem, items, requestedHistory]);
  const inStock = items?.filter((item) => statusFor(item) === "in_stock").length ?? 0;
  const lowStock = items?.filter((i) => {
    return statusFor(i) === "low";
  }).length ?? 0;
  const outOfStock = items?.filter((item) => statusFor(item) === "out").length ?? 0;

  async function handleAdjust() {
    if (!selectedItem || countedStock === "") return;
    const counted = Number(countedStock);
    if (!Number.isInteger(counted) || counted < 0) {
      setMutationNotice({ tone: "error", message: "Tồn đếm được phải là số nguyên không âm." });
      return;
    }
    const adjustment = counted - selectedItem.currentStock;
    if (adjustment === 0) {
      setMutationNotice({ tone: "success", message: "Tồn kho không thay đổi, không ghi nhận movement mới." });
      setShowAdjust(false);
      setSelectedItem(null);
      setCountedStock("");
      return;
    }
    setMutationNotice({ tone: "pending", message: "Đang điều chỉnh tồn kho..." });
    try {
      await adjustMutation.mutateAsync({
        inventoryItemId: selectedItem.id,
        adjustment,
        reason: adjustReason,
        movementType: "manual_adjustment",
      });
      setMutationNotice({ tone: "success", message: "Đã ghi nhận điều chỉnh tồn kho." });
      setShowAdjust(false);
      setCountedStock("");
      setSelectedItem(null);
    } catch (err) {
      setMutationNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể điều chỉnh tồn kho.",
      });
    }
  }

  function selectInventoryItem(item: InventoryItem) {
    const qty = item.location_levels?.[0]?.stocked_quantity ?? 0;
    setSelectedItem({ id: item.id, title: item.title || item.sku || "", currentStock: qty });
    setCountedStock(String(qty));
    setAdjustReason("cycle_count");
    setShowAdjust(true);
  }

  function openHistoryItem(item: InventoryItem) {
    setHistoryItem(item);
    const params = new URLSearchParams(searchParams);
    params.set("history", item.id);
    navigate({ pathname: "/inventory", search: params.toString() ? `?${params.toString()}` : "" });
  }

  function closeHistory() {
    setHistoryItem(null);
    const params = new URLSearchParams(searchParams);
    params.delete("history");
    navigate({ pathname: "/inventory", search: params.toString() ? `?${params.toString()}` : "" });
  }

  function adjustFromHistory(item: InventoryItem) {
    closeHistory();
    selectInventoryItem(item);
  }

  function handleResolvedInventoryScan(resolution: ProductScanResolution) {
    const item = (items || []).find((entry) => entry.id === resolution.inventoryItemId);
    const currentStock = item?.location_levels?.[0]?.stocked_quantity ?? resolution.stock;
    setSelectedItem({
      id: resolution.inventoryItemId,
      title: item?.title || resolution.title || resolution.sku,
      currentStock,
    });
    setCountedStock(String(currentStock));
    setAdjustReason("cycle_count");
    setShowAdjust(true);
    setInventoryScanOpen(false);
  }

  const normalizedSearch = normalizeSearchTerm(search);
  const filteredItems = (items || []).filter((item) => {
    const matchesCategory = categoryId === "all"
      || (item.categories || []).some((category) => category.id === categoryId);
    if (!matchesCategory) return false;
    if (normalizedSearch) {
      const searchableText = normalizeSearchTerm([
        item.title,
        item.sku,
        item.barcode,
        item.id,
        item.product_id,
        ...(item.categories || []).flatMap((category) => [category.name, category.handle]),
      ].filter(Boolean).join(" "));
      if (!searchableText.includes(normalizedSearch)) return false;
    }
    if (stockFilter === "all") return true;
    return statusFor(item) === stockFilter;
  });
  const pageMeta = localListPaginationMeta(filteredItems.length, page, PAGE_SIZE);
  const visibleItems = filteredItems.slice((pageMeta.page - 1) * PAGE_SIZE, pageMeta.page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [search, stockFilter, categoryId]);

  if (error) {
    return (
      <div className="p-4">
        <InlineError message="Không thể tải dữ liệu tồn kho" onRetry={() => refetch()} stale />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title={t("inventory.title")}
        actions={
          <div className="flex flex-wrap gap-2">
            <ExportTemplateActions
              resource="inventory"
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
              variant="secondary"
              size="md"
              icon={<QrCode size={15} aria-hidden="true" />}
              onClick={() => setInventoryScanOpen(true)}
            >
              Scan
            </Button>
            <Button
              variant="primary"
              size="md"
              icon={<SlidersHorizontal size={15} aria-hidden="true" />}
              onClick={() => setShowAdjust(true)}
            >
              {t("inventory.adjustStock")}
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

      {/* Metrics */}
      <ResponsiveMetricGrid>
        {([
          { id: "all", label: "Dòng hàng của merchant", value: total, icon: <Package size={20} />, tone: undefined },
          { id: "in_stock", label: "Trên ngưỡng", value: inStock, icon: undefined, tone: "success" as const },
          { id: "low", label: "Tồn thấp", value: lowStock, icon: undefined, tone: "warning" as const },
          { id: "out", label: "Hết hàng", value: outOfStock, icon: undefined, tone: "danger" as const },
        ] as const).map((metric) => (
          <button key={metric.id} type="button" onClick={() => setFilter(metric.id)} className="text-left focus-visible:outline-2 focus-visible:outline-action-primary focus-visible:outline-offset-2">
            <MetricCell label={metric.label} value={String(metric.value)} icon={metric.icon} tone={metric.tone} />
          </button>
        ))}
      </ResponsiveMetricGrid>
      <p className="text-xs text-text-muted">
        Đếm toàn bộ dòng hàng của merchant, gồm mọi trạng thái sản phẩm và không đổi khi lọc bảng. Số lượng tồn theo kho cửa hàng đang chọn; dòng chưa có tồn tại kho này được tính là 0.
      </p>

      {/* AI Alerts — collapsible banner */}
      {aiAlerts.filter((a) => a.status === "new").length > 0 && (
        <div className="rounded-lg border border-status-warning-border bg-status-warning-bg p-3 text-xs">
          <p className="font-semibold text-status-warning mb-2">
            Cần nhập thêm ({aiAlerts.filter((a) => a.status === "new").length})
          </p>
          {aiAlerts.filter((a) => a.status === "new").slice(0, 3).map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-3 border-t border-status-warning-border/50 py-2 first:border-t-0 first:pt-0">
              <div className="min-w-0">
                <p className="whitespace-normal break-words font-medium text-text-primary">{a.productTitle || "Sản phẩm không còn khả dụng"}</p>
                <p className="mt-0.5 text-text-secondary">
                  {a.sku ? <span className="font-mono">SKU {a.sku}</span> : "SKU không còn khả dụng"}
                  {" · "}{a.currentStock === 0 ? "Đã hết hàng" : `Còn ${a.currentStock}`}{" · "}Ngưỡng nhập {a.reorderLevel}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {a.inventoryItemId && (
                  <button type="button" onClick={() => navigate(`/inventory?item=${encodeURIComponent(a.inventoryItemId || "")}`)} className="text-action-primary hover:underline">Xem trong kho</button>
                )}
                <button
                onClick={async () => {
                  setMutationNotice({ tone: "pending", message: "Đang xác nhận cảnh báo..." });
                  try {
                    await acknowledgeAiAlert(a.id);
                    setMutationNotice({ tone: "success", message: "Đã xác nhận cảnh báo AI." });
                  } catch (err) {
                    setMutationNotice({
                      tone: "error",
                      message: err instanceof Error ? err.message : "Không thể xác nhận cảnh báo.",
                    });
                  }
                }}
                className="text-action-primary hover:underline"
                >
                  Đã xem
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <FilterBar
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={clearFilters}
          >
            Xóa lọc
          </Button>
        }
      >
        <SearchBox value={search} onChange={setSearch} placeholder="Tìm tên, SKU, barcode..." />
        <select
          aria-label="Lọc trạng thái tồn kho"
          value={stockFilter}
          onChange={(event) => setFilter(event.target.value as typeof stockFilter)}
          className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
        >
          <option value="all">Tất cả trạng thái</option>
          <option value="in_stock">Còn hàng</option>
          <option value="low">Sắp hết</option>
          <option value="out">Hết hàng</option>
        </select>
        <select
          aria-label="Lọc danh mục tồn kho"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
        >
          <option value="all">Tất cả danh mục</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>{category.name}</option>
          ))}
        </select>
      </FilterBar>

      {/* Main Table */}
      <Panel title="Sản phẩm">
        {isLoading ? (
          <TableSkeleton rows={6} cols={4} />
        ) : filteredItems.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-sm text-text-muted">
              {(items || []).length === 0 ? t("inventory.emptyProducts") : t("state.noResults")}
            </p>
            {(items || []).length === 0 && (
              <Button variant="primary" className="mt-3" onClick={() => setShowAdjust(true)}>
                {t("inventory.createFirstPO")}
              </Button>
            )}
          </div>
        ) : (
          <>
          <PaginatedListFrame
            label="Phân trang tồn kho"
            rowNoun="sản phẩm tồn kho"
            meta={pageMeta}
            onPageChange={setPage}
          >
            <OperationalTable
              ariaLabel={t("inventory.title")}
              columns={[
                { key: "sku", label: "SKU" },
                { key: "title", label: "Sản phẩm" },
                { key: "category", label: "Danh mục" },
                { key: "stock", label: "Tồn", align: "right", width: 90 },
                { key: "status", label: "Trạng thái" },
                { key: "actions", label: "Thao tác", align: "right", width: 130 },
              ]}
              rows={visibleItems.map((i) => {
                const qty = i.location_levels?.[0]?.stocked_quantity ?? 0;
                return {
                  sku: <span className="font-mono text-xs">{i.sku || "-"}</span>,
                  title: (
                    <div className="min-w-0">
                      <p className="whitespace-normal break-words font-medium leading-5 text-text-primary">
                        {i.title || i.sku || "-"}
                      </p>
                      {i.barcode && <p className="mt-0.5 truncate text-xs text-text-muted">{i.barcode}</p>}
                    </div>
                  ),
                  category: i.categories?.[0]?.name || "Chưa phân loại",
                  stock: <span className="tabular-nums font-medium">{qty}</span>,
                  status:
                    statusFor(i) === "out" ? (
                      <Badge variant="stock" value="out_of_stock" />
                    ) : statusFor(i) === "low" ? (
                      <Badge variant="stock" value="low_stock" />
                    ) : (
                      <Badge variant="stock" value="available" />
                    ),
                  actions: (
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<History size={14} aria-hidden="true" />}
                        aria-label={`Xem lịch sử tồn kho ${i.title || i.sku || i.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          openHistoryItem(i);
                        }}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<SlidersHorizontal size={14} aria-hidden="true" />}
                        aria-label={`Điều chỉnh tồn kho ${i.title || i.sku || i.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          selectInventoryItem(i);
                        }}
                      />
                    </div>
                  ),
                };
              })}
              onRowClick={(_, idx) => {
                const item = idx === undefined ? undefined : visibleItems[idx];
                if (item) {
                  openHistoryItem(item);
                }
              }}
              selectedRowIndex={
                historyItem ? visibleItems.findIndex((item) => item.id === historyItem.id) : null
              }
            />
          </PaginatedListFrame>
          </>
        )}
      </Panel>

      {/* Stock Movement Log */}
      <StockMovementLog />

      <StockHistoryDrawer
        open={Boolean(historyItem)}
        item={historyItem}
        onClose={closeHistory}
        onAdjust={adjustFromHistory}
      />

      {/* ── Adjust Stock Drawer ── */}
      <Drawer
        open={showAdjust}
        title={t("inventory.adjustStock")}
        onClose={() => { setShowAdjust(false); setSelectedItem(null); }}
        actions={
          <>
            <Button
              variant="primary"
              onClick={handleAdjust}
              disabled={!selectedItem || countedStock === "" || adjustMutation.isPending}
            >
              {adjustMutation.isPending ? t("state.loading") : t("state.confirm")}
            </Button>
            <Button variant="secondary" onClick={() => { setShowAdjust(false); setSelectedItem(null); }}>
              {t("state.cancel")}
            </Button>
          </>
        }
      >
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs text-text-muted">{t("inventory.selectProduct")}</label>
                <select
                  value={selectedItem?.id || ""}
                  onChange={(e) => {
                    const item = items?.find((i) => i.id === e.target.value);
                    if (item) selectInventoryItem(item);
                    else {
                      setSelectedItem(null);
                      setCountedStock("");
                    }
                  }}
                  className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm
                             focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                >
                  <option value="">Chọn sản phẩm</option>
                  {(items || []).map((i) => (
                    <option key={i.id} value={i.id}>{i.title || i.sku}</option>
                  ))}
                </select>
              </div>

              {selectedItem && (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-text-muted">
                    Tồn hiện tại: <span className="font-semibold text-text-primary">{selectedItem.currentStock}</span>
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<QrCode size={14} aria-hidden="true" />}
                    onClick={() => setInventoryScanOpen(true)}
                  >
                    Scan tiếp
                  </Button>
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs text-text-muted">Tồn đếm được</label>
                <input
                  type="number"
                  min={0}
                  value={countedStock}
                  onChange={(e) => setCountedStock(e.target.value)}
                  className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm
                             focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                />
                {selectedItem && countedStock !== "" && Number.isFinite(Number(countedStock)) && (
                  <p className="mt-1 text-xs text-text-muted">
                    Delta sẽ ghi nhận:{" "}
                    <span className="font-semibold text-text-primary">
                      {Number(countedStock) - selectedItem.currentStock > 0 ? "+" : ""}
                      {Number(countedStock) - selectedItem.currentStock}
                    </span>
                  </p>
                )}
              </div>

              <div>
                <label className="mb-1 block text-xs text-text-muted">{t("inventory.adjustReason")}</label>
                <select
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm
                             focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                >
                  <option value="cycle_count">Kiểm kê nhanh</option>
                  <option value="damage">{t("inventory.damage")}</option>
                  <option value="loss">{t("inventory.loss")}</option>
                  <option value="correction">{t("inventory.correction")}</option>
                  <option value="found">{t("inventory.found")}</option>
                </select>
              </div>
            </div>
      </Drawer>

      <ImportDialog
        open={importOpen}
        resource="inventory"
        onClose={() => setImportOpen(false)}
        onSuccess={() => void refetch()}
      />
      <StaffScanDialog
        open={inventoryScanOpen}
        title="Scan kiểm kê"
        context="inventory_check"
        onResolved={handleResolvedInventoryScan}
        onClose={() => setInventoryScanOpen(false)}
      />
    </div>
  );
}
