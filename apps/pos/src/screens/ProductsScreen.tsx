import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Button,
  Drawer,
  FilterBar,
  InlineError,
  PaginatedListFrame,
  MetricCell,
  MutationBanner,
  OperationalTable,
  PageHeader,
  Panel,
  ResponsiveMetricGrid,
  SearchBox,
  StatusPill,
  TableSkeleton,
} from "@medusa-snus/ui";
import { ExternalLink, Plus, Printer, Search, Upload } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useAdminProducts, useCreateAdminProduct, useUpdateAdminProduct } from "../hooks/useAdminProducts";
import { useProductCategories } from "../hooks/useProductCategories";
import { useOffsetListPagination } from "../hooks/useOffsetListPagination";
import { useI18n } from "../i18n";
import type { ProductItem } from "../api/client";
import {
  fetchLatestProductResearch,
  fetchProductTag,
  fetchSyncBootstrap,
  runProductResearch,
  type ProductMutationInput,
  type ProductResearchResult,
  type ProductTagView,
} from "../api/endpoints";
import { ExportTemplateActions } from "../components/ExportTemplateActions";
import { ImportDialog } from "../components/ImportDialog";
import { ProductImageField, validateProductImageUrl } from "../components/ProductImageField";
import { emptyProductForm, productToMutationForm } from "./product-form";

function formatMoney(value: number | string | null | undefined) {
  const amount = Number(value || 0);
  return `${amount.toLocaleString("vi-VN")} ₫`;
}

function parseMoneyInput(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits ? Number(digits) : 0;
}

function formatMoneyInput(value: number | string | null | undefined) {
  const amount = Number(value || 0);
  return amount ? amount.toLocaleString("vi-VN") : "0";
}

const TAG_USD_ESTIMATE_RATE_VND = 25000;

function formatTagUsdEstimate(priceVnd: number | string | null | undefined) {
  const amount = Number(priceVnd || 0);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const estimate = Math.max(1, Math.round(amount / TAG_USD_ESTIMATE_RATE_VND));
  return `~ $${estimate.toLocaleString("en-US")} USD`;
}

function ProductTagPreview({ tag }: { tag: ProductTagView }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const usdEstimate = formatTagUsdEstimate(tag.priceVnd);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const updateScale = () => {
      setScale(Math.min(1, frame.clientWidth / 720));
    };

    updateScale();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateScale);
      return () => window.removeEventListener("resize", updateScale);
    }

    const observer = new ResizeObserver(updateScale);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="product-tag-print-scope">
      <div
        ref={frameRef}
        className="product-tag-preview-frame"
        style={{
          "--product-tag-scale": String(scale),
          height: `${420 * scale}px`,
        } as CSSProperties}
      >
        <div className="product-tag-sheet" aria-label={`Product tag for ${tag.title}`}>
          <div className="product-tag-layout">
            <div className="product-tag-content">
              <div className="product-tag-header">
                <div className="product-tag-brand-block">
                  <p className="product-tag-brand">{tag.brand}</p>
                  <div className="product-tag-brand-rule" />
                </div>
                <div className="product-tag-strength-badge">ULTRA STRONG</div>
              </div>

              <div className="product-tag-detail">
                <div className="product-tag-flavor-block">
                  <p className="product-tag-flavor-label">Flavor:</p>
                  <p className="product-tag-flavor">{tag.flavor || tag.title}</p>
                  <div className="product-tag-format-list">
                    {tag.formatLabels.slice(0, 3).map((label) => (
                      <span key={label} className="product-tag-format-chip">
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="product-tag-strength">
                  <span className="product-tag-strength-value">{tag.strengthLabel.replace(/\/pouch/i, "") || "--"}</span>
                  <span className="product-tag-strength-unit">/pouch</span>
                </div>
              </div>

              <div className="product-tag-price-band">
                <div className="product-tag-price-block">
                  <p className="product-tag-price-label">Price</p>
                  <p className="product-tag-price-value">
                    {Number(tag.priceVnd || 0).toLocaleString("vi-VN")} vnd
                  </p>
                </div>
                {usdEstimate && (
                  <p className="product-tag-price-usd">
                    {usdEstimate}
                    <span>estimated</span>
                  </p>
                )}
              </div>
            </div>

            <div className="product-tag-qr-panel">
              <div className="product-tag-qr">
                <QRCodeSVG value={tag.qr.publicUrl} size={176} level="M" includeMargin={false} />
              </div>
              <p className="product-tag-scan-copy">Scan me to build your stash</p>
              <div className="product-tag-qr-meta">
                <p>{tag.sku}</p>
                <p>{tag.barcode || tag.qr.slug}</p>
                <p>v{tag.qr.printVersion}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function printProductTag() {
  document.body.classList.add("printing-product-tag");
  const cleanup = () => document.body.classList.remove("printing-product-tag");
  window.addEventListener("afterprint", cleanup, { once: true });
  window.print();
  window.setTimeout(cleanup, 1000);
}

export default function ProductsScreen() {
  const PAGE_SIZE = 20;
  const navigate = useNavigate();
  const { t } = useI18n();
  const { operator } = useAuth();
  const canManage = operator?.role === "manager" || operator?.role === "owner";
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const [categoryId, setCategoryId] = useState("all");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<ProductItem | null>(null);
  const [form, setForm] = useState<ProductMutationInput>(emptyProductForm());
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "pending"; message: string } | null>(null);
  const [research, setResearch] = useState<ProductResearchResult["data"] | null>(null);
  const [researchLoading, setResearchLoading] = useState(false);
  const [featureEntitlements, setFeatureEntitlements] = useState<Set<string>>(new Set());
  const [tagPreview, setTagPreview] = useState<ProductTagView | null>(null);
  const [tagLoading, setTagLoading] = useState(false);
  const [tagError, setTagError] = useState("");

  const productsQuery = useAdminProducts({
    q: search,
    status,
    categoryId: categoryId === "all" ? undefined : categoryId,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const categoriesQuery = useProductCategories({ status: "active", includeProductCounts: false });
  const createMutation = useCreateAdminProduct();
  const updateMutation = useUpdateAdminProduct();
  const canResearch = canManage && featureEntitlements.has("product_research");

  useEffect(() => {
    void fetchSyncBootstrap()
      .then((res) => {
        const features = res.data.entitlements?.data?.features || res.data.entitlements?.features || [];
        setFeatureEntitlements(new Set(features));
      })
      .catch(() => setFeatureEntitlements(new Set()));
  }, []);

  const products = productsQuery.data?.products || [];
  const categories = categoriesQuery.data?.product_categories || [];
  const { meta: pageMeta, correcting } = useOffsetListPagination(
    productsQuery.error ? undefined : productsQuery.data?.count,
    page,
    PAGE_SIZE,
    setPage,
  );
  const visibleProducts = products;

  useEffect(() => {
    setPage(1);
  }, [search, status, categoryId]);

  const metrics = productsQuery.data?.metrics;

  function openCreate() {
    setEditing(null);
    setForm(emptyProductForm());
    setTagPreview(null);
    setTagError("");
    setDrawerOpen(true);
  }

  function openEdit(product: ProductItem) {
    setEditing(product);
    setResearch(null);
    setTagPreview(null);
    setTagError("");
    setForm(productToMutationForm(product));
    setDrawerOpen(true);
  }

  useEffect(() => {
    if (!drawerOpen || !editing || !canResearch) return;
    let active = true;
    setResearchLoading(true);
    void fetchLatestProductResearch(editing.id)
      .then((result) => {
        if (active) setResearch(result.data);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setResearchLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canResearch, drawerOpen, editing?.id]);

  async function handleResearch() {
    if (!editing || !canResearch) return;
    setResearchLoading(true);
    setNotice(null);
    try {
      const result = await runProductResearch(editing.id);
      setResearch(result.data);
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể research sản phẩm.",
      });
    } finally {
      setResearchLoading(false);
    }
  }

  async function handleSave() {
    if (!canManage) return;
    setNotice({ tone: "pending", message: editing ? "Đang cập nhật sản phẩm..." : "Đang tạo sản phẩm..." });
    try {
      if (editing) {
        await updateMutation.mutateAsync({ id: editing.id, input: form });
        setNotice({ tone: "success", message: "Đã cập nhật sản phẩm." });
      } else {
        await createMutation.mutateAsync(form);
        setNotice({ tone: "success", message: "Đã tạo sản phẩm." });
      }
      setDrawerOpen(false);
      setEditing(null);
      setForm(emptyProductForm());
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể lưu sản phẩm.",
      });
    }
  }

  async function loadProductTag(productId: string) {
    setTagLoading(true);
    setTagError("");
    try {
      const tag = await fetchProductTag(productId);
      setTagPreview(tag);
      return tag;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không thể tải tag sản phẩm.";
      setTagError(message);
      throw new Error(message);
    } finally {
      setTagLoading(false);
    }
  }

  async function handlePrintTag() {
    if (!editing) return;
    try {
      await loadProductTag(editing.id);
      window.setTimeout(printProductTag, 50);
    } catch {
      // Error state is rendered inside the drawer.
    }
  }

  function openInventoryForProduct(product: ProductItem) {
    const variant = product.variants?.[0];
    const query = variant?.sku || product.title;
    navigate(`/inventory?q=${encodeURIComponent(query)}`);
  }

  if (productsQuery.error) {
    return (
      <div className="p-4">
        <InlineError message="Không thể tải danh sách sản phẩm" onRetry={() => productsQuery.refetch()} stale />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title={t("products.title")}
        actions={(
          <div className="flex flex-wrap gap-2">
            <ExportTemplateActions
              resource="products"
              onError={(error) => setNotice({ tone: "error", message: error.message })}
            />
            {canManage && (
              <Button
                variant="secondary"
                size="md"
                icon={<Upload size={15} aria-hidden="true" />}
                onClick={() => setImportOpen(true)}
              >
                Nhập CSV
              </Button>
            )}
            {canManage && (
              <Button
                variant="primary"
                size="md"
                icon={<Plus size={15} aria-hidden="true" />}
                onClick={openCreate}
              >
                {t("products.create")}
              </Button>
            )}
          </div>
        )}
      />

      {notice && (
        <MutationBanner
          tone={notice.tone}
          message={notice.message}
          actionLabel={notice.tone === "error" ? t("state.close") : undefined}
          onAction={() => setNotice(null)}
        />
      )}

      <ResponsiveMetricGrid>
        <MetricCell label="Tổng sản phẩm" value={String(metrics?.total ?? 0)} />
        <MetricCell label="Đang bán" value={String(metrics?.published ?? 0)} tone="success" />
        <MetricCell label="Nháp/ẩn" value={String(metrics?.draft ?? 0)} tone="warning" />
        <MetricCell label="Chưa phân loại" value={String(metrics?.uncategorized ?? 0)} tone="info" />
      </ResponsiveMetricGrid>

      <FilterBar
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setSearch("");
              setStatus("all");
              setCategoryId("all");
            }}
          >
            Xóa lọc
          </Button>
        }
      >
        <SearchBox value={search} onChange={setSearch} placeholder="Tìm tên, SKU, barcode..." />
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
        >
          <option value="all">Tất cả trạng thái</option>
          <option value="published">Đang bán</option>
          <option value="draft">Nháp</option>
        </select>
        <select
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

      <Panel title={t("products.title")}>
        {productsQuery.isLoading || correcting ? (
          <TableSkeleton rows={8} cols={6} />
        ) : (
          <>
          <PaginatedListFrame
            label="Phân trang sản phẩm"
            rowNoun="sản phẩm"
            meta={pageMeta}
            onPageChange={setPage}
          >
            <OperationalTable
              ariaLabel={t("products.title")}
              columns={[
                { key: "title", label: "Sản phẩm" },
                { key: "sku", label: "SKU" },
                { key: "category", label: "Danh mục" },
                { key: "price", label: "Giá bán", align: "right", width: 140 },
                { key: "stock", label: "Tồn", align: "right", width: 100 },
                { key: "status", label: "Trạng thái", width: 140 },
                { key: "inventory", label: "", width: 120 },
              ]}
              rows={visibleProducts.map((product) => {
                const variant = product.variants?.[0];
                return {
                  title: (
                    <div className="min-w-0">
                      <p className="whitespace-normal break-words font-medium leading-5 text-text-primary">
                        {product.title}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-text-muted">
                        {variant?.barcode || "Không có barcode"}
                      </p>
                    </div>
                  ),
                  sku: <span className="font-mono text-xs">{variant?.sku || "-"}</span>,
                  category: product.categories?.[0]?.name || "Chưa phân loại",
                  price: (
                    <span className="tabular-nums">{formatMoney(variant?.prices?.[0]?.amount || 0)}</span>
                  ),
                  stock: <span className="tabular-nums">{variant?.inventory_quantity == null ? "—" : Number(variant.inventory_quantity)}</span>,
                  status: (
                    <StatusPill
                      tone={product.status === "published" ? "success" : "warning"}
                      label={product.status === "published" ? "Đang bán" : "Nháp"}
                    />
                  ),
                  inventory: (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        openInventoryForProduct(product);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-xs text-action-primary hover:bg-action-primary/10"
                      aria-label={`Xem tồn kho của ${product.title}`}
                    >
                      <ExternalLink size={13} aria-hidden="true" />
                      Tồn kho
                    </button>
                  ),
                };
              })}
              onRowClick={
                canManage
                  ? (_row, index) => {
                      const product = index === undefined ? undefined : visibleProducts[index];
                      if (product) openEdit(product);
                    }
                  : undefined
              }
              emptyTitle={t("products.empty")}
              emptyBody={
                search || categoryId !== "all" || status !== "all"
                  ? t("state.noResults")
                  : "Tạo sản phẩm đầu tiên để bắt đầu quản lý catalog."
              }
            />
          </PaginatedListFrame>
          </>
        )}
      </Panel>

      <Drawer
        open={drawerOpen}
        size="wide"
        title={editing ? "Sửa sản phẩm" : "Tạo sản phẩm"}
        onClose={() => {
          setDrawerOpen(false);
          setEditing(null);
          setResearch(null);
          setTagPreview(null);
          setTagError("");
        }}
        actions={canManage ? (
          <>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={
                createMutation.isPending
                || updateMutation.isPending
                || !form.title.trim()
                || (Boolean(editing) && !form.sku.trim())
                || Boolean(validateProductImageUrl(form.imageUrl || ""))
              }
            >
              {(createMutation.isPending || updateMutation.isPending) ? t("state.loading") : t("state.confirm")}
            </Button>
            <Button variant="secondary" onClick={() => setDrawerOpen(false)}>
              {t("state.cancel")}
            </Button>
          </>
        ) : undefined}
      >
        <div className="space-y-4">
          {editing && (
            <div className="rounded-lg border border-border-default bg-surface-subtle p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">Tag sản phẩm</p>
                  <p className="text-xs text-text-muted">In lại tag kệ/hộp với cùng QR dùng cho staff scan và khách Scan & Go.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void loadProductTag(editing.id)}
                    disabled={tagLoading}
                  >
                    {tagLoading ? t("state.loading") : "Xem tag"}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Printer size={14} aria-hidden="true" />}
                    onClick={() => void handlePrintTag()}
                    disabled={tagLoading}
                  >
                    {tagLoading ? "Đang tải..." : "In tag"}
                  </Button>
                </div>
              </div>
              {tagPreview && (
                <div className="mt-3">
                  <ProductTagPreview tag={tagPreview} />
                  {tagPreview.warnings.length > 0 && (
                    <div className="mt-2 rounded-md border border-status-warning-border bg-status-warning-bg px-2 py-1 text-[11px] text-status-warning">
                      {tagPreview.warnings.join(", ")}
                    </div>
                  )}
                </div>
              )}
              {tagError && <p className="mt-2 text-xs text-status-danger">{tagError}</p>}
            </div>
          )}
          {editing && canManage && (
            <div className="rounded-lg border border-border-default bg-surface-subtle p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">Product research</p>
                  <p className="text-xs text-text-muted">
                    {canResearch ? "Review-only, không tự ghi vào catalog." : "Feature locked for current package."}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={handleResearch} disabled={researchLoading || !canResearch}>
                    <Search size={14} className="mr-1" />
                    {researchLoading ? t("state.loading") : "Research"}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => navigate(`/products/${editing.id}/research`)}
                    disabled={!canResearch}
                  >
                    <ExternalLink size={14} className="mr-1" />
                    Workspace
                  </Button>
                </div>
              </div>
              {research && (
                <div className="mt-3 space-y-3 text-sm">
                  <p className="text-text-secondary">{research.summary}</p>
                  {research.bestSource && (
                    <a
                      href={research.bestSource.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-md border border-action-primary bg-surface-panel p-2 hover:bg-surface-hover"
                    >
                      <span className="block text-[11px] font-semibold uppercase text-text-muted">Best source</span>
                      <span className="block text-xs font-semibold text-action-primary">{research.bestSource.title}</span>
                      <span className="block text-xs text-text-muted">{research.bestSource.snippet}</span>
                    </a>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {research.riskFlags.map((flag) => (
                      <span key={flag} className="rounded border border-status-warning-border bg-status-warning-bg px-2 py-1 text-[11px] text-status-warning">
                        {flag}
                      </span>
                    ))}
                  </div>
                  <div className="space-y-2">
                    {research.sources.map((source) => (
                      <a
                        key={source.url}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block rounded-md border border-border-default bg-surface-panel p-2 hover:bg-surface-hover"
                      >
                        <span className="block text-xs font-semibold text-action-primary">{source.title}</span>
                        <span className="block text-xs text-text-muted">{source.snippet}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs text-text-muted">Tên sản phẩm</label>
            <input
              value={form.title}
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
              className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-text-muted">Trạng thái</label>
              <select
                value={form.status}
                onChange={(event) => setForm((current) => ({ ...current, status: event.target.value }))}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
              >
                <option value="published">Đang bán</option>
                <option value="draft">Nháp</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">Danh mục</label>
              <select
                value={form.categoryIds[0] || ""}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  categoryIds: event.target.value ? [event.target.value] : [],
                }))}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
              >
                <option value="">Chưa phân loại</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                {editing ? "SKU" : "SKU (tự tạo nếu bỏ trống)"}
              </label>
              <input
                value={form.sku}
                placeholder={editing ? undefined : "Tự tạo từ tên sản phẩm"}
                onChange={(event) => setForm((current) => ({ ...current, sku: event.target.value }))}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 font-mono text-sm focus:border-action-primary focus:outline-none"
              />
              {!editing && (
                <p className="mt-1 text-[11px] leading-4 text-text-muted">
                  Khi thêm sản phẩm mới, hệ thống sẽ tự sinh SKU duy nhất nếu ô này để trống.
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">Barcode</label>
              <input
                value={form.barcode || ""}
                onChange={(event) => setForm((current) => ({ ...current, barcode: event.target.value }))}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 font-mono text-sm focus:border-action-primary focus:outline-none"
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-text-muted">Giá bán</label>
              <input
                inputMode="numeric"
                value={formatMoneyInput(form.price)}
                onChange={(event) => setForm((current) => ({ ...current, price: parseMoneyInput(event.target.value) }))}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-right text-sm tabular-nums focus:border-action-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">Giá vốn</label>
              <input
                inputMode="numeric"
                value={formatMoneyInput(form.costPrice)}
                onChange={(event) => setForm((current) => ({ ...current, costPrice: parseMoneyInput(event.target.value) }))}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-right text-sm tabular-nums focus:border-action-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">Mức đặt lại hàng</label>
              <input
                type="number"
                min={0}
                value={Number(form.reorderLevel)}
                onChange={(event) => setForm((current) => ({ ...current, reorderLevel: Number(event.target.value || 0) }))}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
              />
              <p className="mt-1 text-[11px] leading-4 text-text-muted">
                Ngưỡng tồn kho tối thiểu dùng để cảnh báo cần nhập thêm hàng, không phải số lượng nhập kho.
              </p>
            </div>
          </div>
          <div className="border-t border-border-default pt-4">
            <ProductImageField
              value={form.imageUrl || ""}
              onChange={(imageUrl) => setForm((current) => ({ ...current, imageUrl }))}
            />
          </div>
          <div className="rounded-lg border border-border-default bg-surface-subtle px-3 py-2 text-xs text-text-muted">
            Tồn kho của sản phẩm mới sẽ khởi tạo ở mức 0. Các thay đổi số lượng tiếp theo đi qua màn Tồn kho hoặc Đặt hàng để giữ audit nhất quán.
          </div>
        </div>
      </Drawer>

      <ImportDialog
        open={importOpen}
        resource="products"
        onClose={() => setImportOpen(false)}
        onSuccess={() => void productsQuery.refetch()}
      />
    </div>
  );
}
