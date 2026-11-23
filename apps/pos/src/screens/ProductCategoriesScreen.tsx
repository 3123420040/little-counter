import { useEffect, useMemo, useState } from "react";
import { useOffsetListPagination } from "../hooks/useOffsetListPagination";
import {
  Button,
  ConfirmDialog,
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
import {
  useCreateProductCategory,
  useDeleteProductCategory,
  useProductCategories,
  useUpdateProductCategory,
} from "../hooks/useProductCategories";
import { useAuth } from "../hooks/useAuth";
import { useI18n } from "../i18n";
import type { ProductCategoryItem } from "../api/client";
import type { ProductCategoryMutationInput } from "../api/endpoints";
import { ExportTemplateActions } from "../components/ExportTemplateActions";
import { ImportDialog } from "../components/ImportDialog";
import { Plus, Upload } from "lucide-react";

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const EMPTY_FORM: ProductCategoryMutationInput = {
  name: "",
  handle: "",
  description: "",
  rank: 0,
  isActive: true,
};

export default function ProductCategoriesScreen() {
  const PAGE_SIZE = 20;
  const { t } = useI18n();
  const { operator } = useAuth();
  const canManage = operator?.role === "manager" || operator?.role === "owner";
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<ProductCategoryItem | null>(null);
  const [form, setForm] = useState<ProductCategoryMutationInput>(EMPTY_FORM);
  const [handleTouched, setHandleTouched] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "pending"; message: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    mode: "delete" | "toggle";
    category: ProductCategoryItem;
  } | null>(null);

  const { data, isLoading, error, refetch } = useProductCategories({
    q: search,
    status,
    includeProductCounts: true,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  // The table is server-paged. Request the two inexpensive count-only slices
  // separately so the status KPIs never become counts for just the visible
  // page.
  const activeCategoryCount = useProductCategories({
    q: search,
    status: "active",
    includeProductCounts: false,
    limit: 1,
    offset: 0,
  });
  const inactiveCategoryCount = useProductCategories({
    q: search,
    status: "inactive",
    includeProductCounts: false,
    limit: 1,
    offset: 0,
  });
  const createMutation = useCreateProductCategory();
  const updateMutation = useUpdateProductCategory();
  const deleteMutation = useDeleteProductCategory();
  const categories = data?.product_categories || [];
  const { meta: pageMeta, correcting } = useOffsetListPagination(
    error ? undefined : data?.count, page, PAGE_SIZE, setPage,
  );

  useEffect(() => {
    setPage(1);
  }, [search, status]);

  useEffect(() => {
    if (handleTouched) return;
    setForm((current) => ({ ...current, handle: slugify(current.name || "") }));
  }, [form.name, handleTouched]);

  const metrics = useMemo(() => ({
    total: Number(data?.count || 0),
    active: status === "inactive" ? 0 : Number(activeCategoryCount.data?.count || 0),
    inactive: status === "active" ? 0 : Number(inactiveCategoryCount.data?.count || 0),
    uncategorized: Number(data?.meta?.uncategorizedProductCount || 0),
  }), [
    activeCategoryCount.data?.count,
    data?.count,
    data?.meta?.uncategorizedProductCount,
    inactiveCategoryCount.data?.count,
    search,
    status,
  ]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setHandleTouched(false);
    setDrawerOpen(true);
  }

  function openEdit(category: ProductCategoryItem) {
    setEditing(category);
    setForm({
      name: category.name,
      handle: category.handle,
      description: category.description || "",
      rank: category.rank || 0,
      isActive: category.isActive !== false,
    });
    setHandleTouched(true);
    setDrawerOpen(true);
  }

  async function handleSave() {
    if (!canManage) return;
    setNotice({ tone: "pending", message: editing ? "Đang cập nhật danh mục..." : "Đang tạo danh mục..." });
    try {
      if (editing) {
        await updateMutation.mutateAsync({ id: editing.id, input: form });
        setNotice({ tone: "success", message: "Đã cập nhật danh mục." });
      } else {
        await createMutation.mutateAsync(form);
        setNotice({ tone: "success", message: "Đã tạo danh mục." });
      }
      setDrawerOpen(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      setHandleTouched(false);
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể lưu danh mục.",
      });
    }
  }

  async function handleConfirmAction() {
    if (!confirmAction || !canManage) return;
    const { category, mode } = confirmAction;
    setNotice({
      tone: "pending",
      message: mode === "delete" ? "Đang xóa danh mục..." : "Đang cập nhật trạng thái danh mục...",
    });
    try {
      if (mode === "delete") {
        await deleteMutation.mutateAsync(category.id);
        setNotice({ tone: "success", message: "Đã xóa danh mục." });
      } else {
        await updateMutation.mutateAsync({
          id: category.id,
          input: { isActive: !(category.isActive !== false) },
        });
        setNotice({
          tone: "success",
          message: category.isActive !== false ? "Đã ẩn danh mục." : "Đã kích hoạt danh mục.",
        });
      }
      setConfirmAction(null);
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể cập nhật danh mục.",
      });
    }
  }

  if (error) {
    return (
      <div className="p-4">
        <InlineError message="Không thể tải danh mục sản phẩm" onRetry={() => refetch()} stale />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title={t("categories.title")}
        actions={(
          <div className="flex flex-wrap gap-2">
            <ExportTemplateActions
              resource="categories"
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
                {t("categories.create")}
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
        <MetricCell label="Tổng danh mục" value={String(metrics.total)} />
        <MetricCell label="Đang hoạt động" value={String(metrics.active)} tone="success" />
        <MetricCell label="Đã ẩn" value={String(metrics.inactive)} tone="warning" />
        <MetricCell label="Chưa phân loại" value={String(metrics.uncategorized)} tone="info" />
      </ResponsiveMetricGrid>

      <FilterBar
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setSearch("");
              setStatus("all");
            }}
          >
            Xóa lọc
          </Button>
        }
      >
        <SearchBox value={search} onChange={setSearch} placeholder="Tìm tên hoặc handle..." />
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
          className="h-10 rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
        >
          <option value="all">Tất cả trạng thái</option>
          <option value="active">Đang hoạt động</option>
          <option value="inactive">Đã ẩn</option>
        </select>
      </FilterBar>

      <Panel title={t("categories.title")}>
        {isLoading || correcting ? (
          <TableSkeleton rows={6} cols={6} />
        ) : (
          <>
          <PaginatedListFrame
            label="Phân trang danh mục"
            rowNoun="danh mục"
            meta={pageMeta}
            busy={isLoading}
            onPageChange={setPage}
          >
            <OperationalTable
              ariaLabel={t("categories.title")}
              columns={[
                { key: "name", label: "Danh mục" },
                { key: "handle", label: "Handle" },
                { key: "count", label: "Sản phẩm", align: "right", width: 100 },
                { key: "status", label: "Trạng thái", width: 130 },
                { key: "updated", label: "Cập nhật", width: 130 },
                { key: "actions", label: "Tác vụ", width: 220 },
              ]}
              rows={categories.map((category) => ({
                name: (
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text-primary">{category.name}</p>
                    {category.description && (
                      <p className="mt-0.5 truncate text-xs text-text-muted">{category.description}</p>
                    )}
                  </div>
                ),
                handle: <span className="font-mono text-xs">{category.handle}</span>,
                count: <span className="tabular-nums">{Number(category.productCount || 0)}</span>,
                status: (
                  <StatusPill
                    tone={category.isActive !== false ? "success" : "warning"}
                    label={category.isActive !== false ? "Đang hoạt động" : "Đã ẩn"}
                  />
                ),
                updated: category.updatedAt
                  ? new Date(category.updatedAt).toLocaleDateString("vi-VN")
                  : "-",
                actions: (
                  <div className="flex flex-wrap gap-2">
                    {canManage && (
                      <Button variant="secondary" size="sm" onClick={() => openEdit(category)}>
                        {t("state.edit")}
                      </Button>
                    )}
                    {canManage && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setConfirmAction({ mode: "toggle", category })}
                      >
                        {category.isActive !== false ? "Ẩn" : "Kích hoạt"}
                      </Button>
                    )}
                    {canManage && Number(category.productCount || 0) === 0 && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => setConfirmAction({ mode: "delete", category })}
                      >
                        {t("state.delete")}
                      </Button>
                    )}
                  </div>
                ),
              }))}
              emptyTitle={t("categories.empty")}
              emptyBody={
                search ? t("state.noResults") : "Tạo danh mục đầu tiên để bắt đầu phân loại sản phẩm."
              }
            />
          </PaginatedListFrame>
          </>
        )}
      </Panel>

      <Drawer
        open={drawerOpen}
        title={editing ? "Sửa danh mục" : "Tạo danh mục"}
        onClose={() => {
          setDrawerOpen(false);
          setEditing(null);
          setHandleTouched(false);
        }}
        actions={canManage ? (
          <>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={createMutation.isPending || updateMutation.isPending || !form.name?.trim() || !form.handle?.trim()}
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
          <div>
            <label className="mb-1 block text-xs text-text-muted">Tên danh mục</label>
            <input
              value={form.name || ""}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-muted">Handle</label>
            <input
              value={form.handle || ""}
              onChange={(event) => {
                setHandleTouched(true);
                setForm((current) => ({ ...current, handle: slugify(event.target.value) }));
              }}
              className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 font-mono text-sm focus:border-action-primary focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-muted">Mô tả</label>
            <textarea
              value={form.description || ""}
              onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
              rows={3}
              className="w-full rounded-md border border-border-default bg-surface-panel px-3 py-2 text-sm focus:border-action-primary focus:outline-none"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-text-muted">Thứ tự</label>
              <input
                type="number"
                value={Number(form.rank || 0)}
                onChange={(event) => setForm((current) => ({ ...current, rank: Number(event.target.value || 0) }))}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
              />
            </div>
            <label className="flex items-center gap-2 rounded-md border border-border-default bg-surface-panel px-3 py-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={form.isActive !== false}
                onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.checked }))}
              />
              Đang hoạt động
            </label>
          </div>
        </div>
      </Drawer>

      <ConfirmDialog
        open={!!confirmAction}
        title={confirmAction?.mode === "delete" ? "Xóa danh mục?" : "Cập nhật trạng thái danh mục?"}
        message={confirmAction?.mode === "delete"
          ? "Danh mục chỉ được xóa khi chưa có sản phẩm gán vào."
          : confirmAction?.category.isActive !== false
            ? "Ẩn danh mục này khỏi các luồng gán và lọc sản phẩm?"
            : "Kích hoạt lại danh mục này?"
        }
        confirmLabel={confirmAction?.mode === "delete" ? "Xóa danh mục" : "Xác nhận"}
        danger={confirmAction?.mode === "delete"}
        pending={deleteMutation.isPending || updateMutation.isPending}
        onConfirm={handleConfirmAction}
        onCancel={() => setConfirmAction(null)}
      />

      <ImportDialog
        open={importOpen}
        resource="categories"
        onClose={() => setImportOpen(false)}
        onSuccess={() => void refetch()}
      />
    </div>
  );
}
