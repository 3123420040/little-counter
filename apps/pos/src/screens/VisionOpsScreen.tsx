import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useOffsetListPagination } from "../hooks/useOffsetListPagination";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  InlineError,
  PaginatedListFrame,
  loadedListPaginationMeta,
  OperationalTable,
  PageHeader,
  Panel,
  ScreenState,
  StatusPill,
  TableSkeleton,
} from "@medusa-snus/ui";
import { Check, Plus, RefreshCcw, Search, Upload, X } from "lucide-react";
import {
  fetchVisionCatalogReadiness,
  fetchVisionScanReport,
  createVisionReferenceImage,
  syncVisionReferenceImagesFromMetadata,
  updateVisionReferenceImage,
  uploadVisionReferenceImage,
  type VisionCatalogReadinessItem,
  type VisionCatalogReadinessStatus,
  type VisionScanReportItem,
} from "../api/endpoints";

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toIsoDate(date);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Không đọc được file ảnh."));
    reader.readAsDataURL(file);
  });
}

function formatDateTime(value: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString("vi-VN");
}

function formatConfidence(value: number | null) {
  if (value === null || value === undefined) return "-";
  return `${Math.round(Math.max(0, Math.min(1, Number(value))) * 100)}%`;
}

function readinessTone(status: VisionCatalogReadinessStatus | string) {
  if (status === "ready" || status.startsWith("ready_")) return "success" as const;
  if (status === "index_failed") return "danger" as const;
  if (status === "needs_index" || status === "pending_provider_sync" || status === "pending_approval") return "warning" as const;
  return "neutral" as const;
}

function formatReadinessReason(reason: string) {
  return reason.replaceAll("_", " ");
}

function decisionTone(decision: VisionScanReportItem["decision"]) {
  if (decision === "accepted") return "success" as const;
  if (decision === "corrected") return "warning" as const;
  if (decision === "rejected" || decision === "unresolved") return "danger" as const;
  return "neutral" as const;
}

function ReadinessSummary({ rows }: { rows: VisionCatalogReadinessItem[] }) {
  const summary = useMemo(() => ({
    ready: rows.filter((row) => row.readiness === "ready").length,
    needsImage: rows.filter((row) => row.readiness === "needs_image").length,
    needsIndex: rows.filter((row) => row.readiness === "needs_index").length,
    indexFailed: rows.filter((row) => row.readiness === "index_failed").length,
  }), [rows]);

  return (
    <section aria-label="Tóm tắt catalog đã tải">
      <p className="mb-2 text-xs text-text-muted">Tóm tắt {rows.length} biến thể đã tải</p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <div className="rounded-md border border-border-default bg-surface-subtle p-3">
        <p className="text-xs text-text-muted">Ready</p>
        <p className="mt-1 text-lg font-semibold text-status-success">{summary.ready}</p>
      </div>
      <div className="rounded-md border border-border-default bg-surface-subtle p-3">
        <p className="text-xs text-text-muted">Needs image</p>
        <p className="mt-1 text-lg font-semibold text-text-primary">{summary.needsImage}</p>
      </div>
      <div className="rounded-md border border-border-default bg-surface-subtle p-3">
        <p className="text-xs text-text-muted">Needs index</p>
        <p className="mt-1 text-lg font-semibold text-status-warning">{summary.needsIndex}</p>
      </div>
      <div className="rounded-md border border-border-default bg-surface-subtle p-3">
        <p className="text-xs text-text-muted">Index failed</p>
        <p className="mt-1 text-lg font-semibold text-status-danger">{summary.indexFailed}</p>
      </div>
      </div>
    </section>
  );
}

export default function VisionOpsScreen() {
  const PAGE_SIZE = 20;
  const queryClient = useQueryClient();
  const [catalogSearch, setCatalogSearch] = useState("");
  const [dateFrom, setDateFrom] = useState(daysAgo(7));
  const [dateTo, setDateTo] = useState("");
  const [storeId, setStoreId] = useState("");
  const [decision, setDecision] = useState("");
  const [provider, setProvider] = useState("");
  const [source, setSource] = useState("");
  const [variantId, setVariantId] = useState("");
  const [selectedCatalogVariantId, setSelectedCatalogVariantId] = useState<string | null>(null);
  const [catalogPage, setCatalogPage] = useState(1);
  const [reportPage, setReportPage] = useState(1);
  const [referenceImageUrl, setReferenceImageUrl] = useState("");
  const [referenceImageType, setReferenceImageType] = useState("front");
  const [referenceQualityStatus, setReferenceQualityStatus] = useState("approved");
  const [referenceIsPrimary, setReferenceIsPrimary] = useState(true);
  const [referenceUploadBase64, setReferenceUploadBase64] = useState("");
  const [referenceUploadFileName, setReferenceUploadFileName] = useState("");
  const [referenceUploadContentType, setReferenceUploadContentType] = useState("");
  const [referenceUploadError, setReferenceUploadError] = useState("");
  const [referenceFileInputKey, setReferenceFileInputKey] = useState(0);

  const readinessQuery = useQuery({
    queryKey: ["visionCatalogReadiness", catalogSearch],
    queryFn: () => fetchVisionCatalogReadiness({ q: catalogSearch || undefined, limit: 100 }),
  });

  const reportQuery = useQuery({
    queryKey: ["visionScanReport", dateFrom, dateTo, storeId, decision, provider, source, variantId, reportPage],
    queryFn: () => fetchVisionScanReport({
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      storeId: storeId || undefined,
      decision: decision || undefined,
      provider: provider || undefined,
      source: source || undefined,
      variantId: variantId || undefined,
      limit: PAGE_SIZE,
      offset: (reportPage - 1) * PAGE_SIZE,
    }),
  });

  const syncMutation = useMutation({
    mutationFn: syncVisionReferenceImagesFromMetadata,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["visionCatalogReadiness"] });
    },
  });

  const readinessRows = readinessQuery.data?.data || [];
  const reportRows = reportQuery.data?.data || [];
  const catalogMeta = loadedListPaginationMeta(readinessRows.length, catalogPage, PAGE_SIZE);
  const visibleReadinessRows = readinessRows.slice(
    (catalogMeta.page - 1) * PAGE_SIZE,
    catalogMeta.page * PAGE_SIZE,
  );
  const { meta: reportMeta, correcting: reportCorrecting } = useOffsetListPagination(
    reportQuery.error ? undefined : reportQuery.data?.meta.count, reportPage, PAGE_SIZE, setReportPage,
  );
  const selectedCatalogItem = selectedCatalogVariantId === null
    ? null
    : readinessRows.find((item) => item.variantId === selectedCatalogVariantId) || null;
  const selectedCatalogRowIndex = visibleReadinessRows.findIndex((item) => item.variantId === selectedCatalogVariantId);

  useEffect(() => {
    setCatalogPage(1);
    setSelectedCatalogVariantId(null);
  }, [catalogSearch]);

  useEffect(() => {
    setReportPage(1);
  }, [dateFrom, dateTo, storeId, decision, provider, source, variantId]);

  const createReferenceMutation = useMutation({
    mutationFn: () => {
      if (!selectedCatalogItem) throw new Error("Chọn một variant trong bảng readiness trước.");
      return createVisionReferenceImage({
        storeId: storeId || undefined,
        productId: selectedCatalogItem.productId,
        variantId: selectedCatalogItem.variantId,
        imageUrl: referenceImageUrl,
        imageType: referenceImageType,
        qualityStatus: referenceQualityStatus,
        isPrimary: referenceIsPrimary,
        metadata: { source: "vision_ops_screen" },
      });
    },
    onSuccess: () => {
      setReferenceImageUrl("");
      queryClient.invalidateQueries({ queryKey: ["visionCatalogReadiness"] });
    },
  });

  const uploadReferenceMutation = useMutation({
    mutationFn: () => {
      if (!selectedCatalogItem) throw new Error("Chọn một variant trong bảng readiness trước.");
      if (!referenceUploadBase64) throw new Error("Chọn file ảnh reference trước.");
      return uploadVisionReferenceImage({
        storeId: storeId || undefined,
        productId: selectedCatalogItem.productId,
        variantId: selectedCatalogItem.variantId,
        imageBase64: referenceUploadBase64,
        fileName: referenceUploadFileName,
        contentType: referenceUploadContentType,
        imageType: referenceImageType,
        qualityStatus: referenceQualityStatus,
        isPrimary: referenceIsPrimary,
        metadata: { source: "vision_ops_screen" },
      });
    },
    onSuccess: () => {
      setReferenceUploadBase64("");
      setReferenceUploadFileName("");
      setReferenceUploadContentType("");
      setReferenceFileInputKey((value) => value + 1);
      queryClient.invalidateQueries({ queryKey: ["visionCatalogReadiness"] });
    },
  });

  const updatePrimaryMutation = useMutation({
    mutationFn: (qualityStatus: "approved" | "rejected") => {
      if (!selectedCatalogItem?.primaryImageId) throw new Error("Variant chưa có primary image để cập nhật.");
      return updateVisionReferenceImage(selectedCatalogItem.primaryImageId, {
        qualityStatus,
        isPrimary: qualityStatus === "approved",
        metadata: { source: "vision_ops_screen" },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["visionCatalogReadiness"] });
    },
  });

  async function handleReferenceFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    setReferenceUploadError("");
    if (!file) {
      setReferenceUploadBase64("");
      setReferenceUploadFileName("");
      setReferenceUploadContentType("");
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      setReferenceUploadBase64(dataUrl);
      setReferenceUploadFileName(file.name);
      setReferenceUploadContentType(file.type);
    } catch (error) {
      setReferenceUploadBase64("");
      setReferenceUploadFileName("");
      setReferenceUploadContentType("");
      setReferenceUploadError(error instanceof Error ? error.message : "Không đọc được file ảnh.");
    }
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Vision POS"
        subtitle="Trạng thái danh mục và phản hồi nhận diện sản phẩm."
        status={<StatusPill tone="info" label="AI Fan" />}
        actions={(
          <Button
            variant="primary"
            icon={<RefreshCcw size={15} aria-hidden="true" />}
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            {syncMutation.isPending ? "Đang sync..." : "Sync ảnh"}
          </Button>
        )}
      />

      {syncMutation.error && (
        <InlineError
          message={syncMutation.error instanceof Error ? syncMutation.error.message : "Không sync được ảnh."}
          onRetry={() => syncMutation.reset()}
        />
      )}
      {createReferenceMutation.error && (
        <InlineError
          message={createReferenceMutation.error instanceof Error ? createReferenceMutation.error.message : "Không thêm được reference image."}
          onRetry={() => createReferenceMutation.reset()}
        />
      )}
      {(uploadReferenceMutation.error || referenceUploadError) && (
        <InlineError
          message={referenceUploadError || (uploadReferenceMutation.error instanceof Error ? uploadReferenceMutation.error.message : "Không upload được reference image.")}
          onRetry={() => {
            setReferenceUploadError("");
            uploadReferenceMutation.reset();
          }}
        />
      )}
      {updatePrimaryMutation.error && (
        <InlineError
          message={updatePrimaryMutation.error instanceof Error ? updatePrimaryMutation.error.message : "Không cập nhật được primary image."}
          onRetry={() => updatePrimaryMutation.reset()}
        />
      )}
      {syncMutation.data && (
        <div className="rounded-md border border-status-success-border bg-status-success-bg px-3 py-2 text-sm text-status-success">
          Đã thêm {syncMutation.data.data.insertedCount} ảnh reference từ {syncMutation.data.data.totalProductsWithImageUrl} sản phẩm có imageUrl.
        </div>
      )}
      {createReferenceMutation.data && (
        <div className="rounded-md border border-status-success-border bg-status-success-bg px-3 py-2 text-sm text-status-success">
          Đã thêm reference image cho {createReferenceMutation.data.data.sku || createReferenceMutation.data.data.variantId}.
        </div>
      )}
      {uploadReferenceMutation.data && (
        <div className="rounded-md border border-status-success-border bg-status-success-bg px-3 py-2 text-sm text-status-success">
          Đã upload reference image cho {uploadReferenceMutation.data.data.sku || uploadReferenceMutation.data.data.variantId}.
        </div>
      )}
      {updatePrimaryMutation.data && (
        <div className="rounded-md border border-status-success-border bg-status-success-bg px-3 py-2 text-sm text-status-success">
          Đã cập nhật primary image {updatePrimaryMutation.data.data.imageId}.
        </div>
      )}

      <Panel title="Catalog readiness">
        <div className="space-y-3 p-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="flex h-9 flex-1 items-center gap-2 rounded-md border border-border-default bg-surface-panel px-3">
              <Search size={15} className="text-text-muted" aria-hidden="true" />
              <input
                value={catalogSearch}
                onChange={(event) => setCatalogSearch(event.target.value)}
                placeholder="SKU hoặc tên sản phẩm"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted"
              />
            </div>
            <Button variant="secondary" onClick={() => readinessQuery.refetch()} disabled={readinessQuery.isFetching}>
              Refresh
            </Button>
          </div>

          {readinessQuery.isLoading ? (
            <TableSkeleton rows={6} cols={6} />
          ) : readinessQuery.error ? (
            <InlineError
              message={readinessQuery.error instanceof Error ? readinessQuery.error.message : "Không tải được readiness."}
              onRetry={() => readinessQuery.refetch()}
              stale
            />
          ) : (
            <>
              <ReadinessSummary rows={readinessRows} />
              <PaginatedListFrame
                label="Phân trang vision catalog readiness"
                rowNoun="biến thể đã tải"
                meta={catalogMeta}
                busy={readinessQuery.isFetching}
                onPageChange={setCatalogPage}
              >
                <OperationalTable
                  ariaLabel="Vision catalog readiness"
                  minWidth={1180}
                  selectedRowIndex={selectedCatalogRowIndex >= 0 ? selectedCatalogRowIndex : null}
                  onRowClick={(_row, rowIndex) => {
                    const item = typeof rowIndex === "number" ? visibleReadinessRows[rowIndex] : null;
                    setSelectedCatalogVariantId(item?.variantId || null);
                  }}
                  columns={[
                    { key: "product", label: "Sản phẩm" },
                    { key: "sku", label: "SKU" },
                    { key: "readiness", label: "Readiness" },
                    { key: "images", label: "Ảnh" },
                    { key: "requirements", label: "Yêu cầu" },
                    { key: "index", label: "Index" },
                    { key: "variant", label: "Variant" },
                  ]}
                  rows={visibleReadinessRows.map((item) => ({
                    product: <span className="font-medium text-text-primary">{item.title}</span>,
                    sku: <span className="font-mono text-xs">{item.sku || "-"}</span>,
                    readiness: (
                      <StatusPill
                        tone={readinessTone(item.readinessStatus || item.readiness)}
                        label={item.readinessStatus || item.readiness}
                      />
                    ),
                    images: `${item.referenceImageCount} ref · ${item.approvedImageCount} approved`,
                    requirements: (
                      <div className="max-w-72 text-xs text-text-muted">
                        <p>
                          {item.readinessReasons.length > 0
                            ? item.readinessReasons.map(formatReadinessReason).join(", ")
                            : "Ready"}
                        </p>
                        <p className="mt-0.5 font-mono">
                          front {item.approvedFrontImageCount || 0} · counter{" "}
                          {item.approvedCounterCaptureImageCount || 0} · strength{" "}
                          {item.approvedStrengthTextImageCount || 0}
                        </p>
                      </div>
                    ),
                    index: `${item.syncedImageCount} synced · ${item.failedIndexCount} failed`,
                    variant: <span className="font-mono text-xs">{item.variantId}</span>,
                  }))}
                  emptyTitle="Chưa có readiness"
                  emptyBody="Không có sản phẩm phù hợp bộ lọc hiện tại."
                />
              </PaginatedListFrame>
              <div className="rounded-md border border-border-default bg-surface-subtle p-3">
                <div className="grid gap-2 xl:grid-cols-[minmax(180px,1fr)_minmax(220px,2fr)_minmax(220px,2fr)_140px_150px_auto]">
                  <div className="min-w-0">
                    <p className="text-xs text-text-muted">Selected variant</p>
                    <p className="truncate font-mono text-xs text-text-primary">{selectedCatalogItem?.variantId || "Chọn một row"}</p>
                    <p className="truncate text-xs text-text-muted">{selectedCatalogItem?.sku || "-"}</p>
                  </div>
                  <input
                    value={referenceImageUrl}
                    onChange={(event) => setReferenceImageUrl(event.target.value)}
                    placeholder="https://... reference image"
                    className="h-9 rounded-md border border-border-default bg-surface-panel px-3 text-sm outline-none placeholder:text-text-muted"
                  />
                  <input
                    key={referenceFileInputKey}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleReferenceFileChange}
                    className="h-9 min-w-0 rounded-md border border-border-default bg-surface-panel px-3 py-1.5 text-xs text-text-muted file:mr-3 file:rounded file:border-0 file:bg-surface-subtle file:px-2 file:py-1 file:text-xs file:text-text-primary"
                  />
                  <select
                    value={referenceImageType}
                    onChange={(event) => setReferenceImageType(event.target.value)}
                    className="h-9 rounded-md border border-border-default bg-surface-panel px-3 text-sm outline-none"
                  >
                    <option value="front">Front</option>
                    <option value="primary">Primary</option>
                    <option value="counter_capture">Counter</option>
                    <option value="strength_text">Strength</option>
                    <option value="angle">Angle</option>
                    <option value="side">Side</option>
                    <option value="back">Back</option>
                    <option value="qr_tag">QR tag</option>
                  </select>
                  <select
                    value={referenceQualityStatus}
                    onChange={(event) => setReferenceQualityStatus(event.target.value)}
                    className="h-9 rounded-md border border-border-default bg-surface-panel px-3 text-sm outline-none"
                  >
                    <option value="approved">Approved</option>
                    <option value="pending">Pending</option>
                    <option value="rejected">Rejected</option>
                  </select>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex h-9 items-center gap-2 rounded-md border border-border-default bg-surface-panel px-3 text-xs text-text-muted">
                      <input
                        type="checkbox"
                        checked={referenceIsPrimary}
                        onChange={(event) => setReferenceIsPrimary(event.target.checked)}
                      />
                      Primary
                    </label>
                    <Button
                      variant="secondary"
                      icon={<Plus size={15} aria-hidden="true" />}
                      onClick={() => createReferenceMutation.mutate()}
                      disabled={!selectedCatalogItem || !referenceImageUrl.trim() || createReferenceMutation.isPending}
                    >
                      Add
                    </Button>
                    <Button
                      variant="secondary"
                      icon={<Upload size={15} aria-hidden="true" />}
                      onClick={() => uploadReferenceMutation.mutate()}
                      disabled={!selectedCatalogItem || !referenceUploadBase64 || uploadReferenceMutation.isPending}
                    >
                      Upload
                    </Button>
                  </div>
                </div>
                {selectedCatalogItem?.primaryImageId && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                    <span className="font-mono">{selectedCatalogItem.primaryImageId}</span>
                    <Button
                      variant="secondary"
                      icon={<Check size={15} aria-hidden="true" />}
                      onClick={() => updatePrimaryMutation.mutate("approved")}
                      disabled={updatePrimaryMutation.isPending}
                    >
                      Approve primary
                    </Button>
                    <Button
                      variant="secondary"
                      icon={<X size={15} aria-hidden="true" />}
                      onClick={() => updatePrimaryMutation.mutate("rejected")}
                      disabled={updatePrimaryMutation.isPending}
                    >
                      Reject primary
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </Panel>

      <Panel title="Scan feedback">
        <div className="space-y-3 p-4">
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[150px_150px_180px_180px_190px_190px_minmax(190px,1fr)_auto]">
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              className="h-9 rounded-md border border-border-default bg-surface-panel px-3 text-sm outline-none"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              className="h-9 rounded-md border border-border-default bg-surface-panel px-3 text-sm outline-none"
            />
            <input
              value={storeId}
              onChange={(event) => setStoreId(event.target.value)}
              placeholder="storeId"
              className="h-9 rounded-md border border-border-default bg-surface-panel px-3 text-sm outline-none placeholder:text-text-muted"
            />
            <select
              value={decision}
              onChange={(event) => setDecision(event.target.value)}
              className="h-9 rounded-md border border-border-default bg-surface-panel px-3 text-sm outline-none"
            >
              <option value="">Tất cả decision</option>
              <option value="pending">Pending</option>
              <option value="accepted">Accepted</option>
              <option value="corrected">Corrected</option>
              <option value="rejected">Rejected</option>
              <option value="unresolved">Unresolved</option>
            </select>
            <select
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className="h-9 rounded-md border border-border-default bg-surface-panel px-3 text-sm outline-none"
            >
              <option value="">Tất cả source</option>
              <option value="qr">QR</option>
              <option value="barcode">Barcode</option>
              <option value="vision_provider">Vision</option>
              <option value="manual">Manual</option>
            </select>
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              className="h-9 rounded-md border border-border-default bg-surface-panel px-3 text-sm outline-none"
            >
              <option value="">Tất cả provider</option>
              <option value="qr_first">QR first</option>
              <option value="google_vision_ocr">Google OCR</option>
              <option value="google_product_search">Google Product Search</option>
              <option value="budget_guard">Budget guard</option>
              <option value="disabled">Disabled</option>
              <option value="noop">Noop</option>
            </select>
            <input
              value={variantId}
              onChange={(event) => setVariantId(event.target.value)}
              placeholder="variantId"
              className="h-9 rounded-md border border-border-default bg-surface-panel px-3 text-sm outline-none placeholder:text-text-muted"
            />
            <Button variant="secondary" onClick={() => reportQuery.refetch()} disabled={reportQuery.isFetching}>
              Refresh
            </Button>
          </div>

          {reportQuery.isLoading ? (
            <TableSkeleton rows={6} cols={10} />
          ) : reportQuery.error ? (
            <InlineError
              message={reportQuery.error instanceof Error ? reportQuery.error.message : "Không tải được scan report."}
              onRetry={() => reportQuery.refetch()}
              stale
            />
          ) : reportRows.length === 0 ? (
            <ScreenState
              state="empty"
              title="Chưa có scan"
              body="Sau khi quét ảnh, kết quả nhận diện xuất hiện ở đây."
            />
          ) : (
            <>
            <PaginatedListFrame
              label="Phân trang phản hồi vision scan"
              loading={reportCorrecting}
              loadingContent={<div className="p-3 text-sm text-text-muted">Đang tải trang phù hợp...</div>}
              showPagination={!reportCorrecting}
              rowNoun="scan"
              meta={reportMeta}
              busy={reportQuery.isFetching}
              onPageChange={setReportPage}
            >
              <OperationalTable
                ariaLabel="Vision scan feedback"
                minWidth={1540}
                columns={[
                  { key: "time", label: "Thời gian" },
                  { key: "scope", label: "Scope" },
                  { key: "decision", label: "Decision" },
                  { key: "source", label: "Source" },
                  { key: "suggested", label: "Suggested" },
                  { key: "selected", label: "Selected" },
                  { key: "confidence", label: "Conf." },
                  { key: "provider", label: "Provider" },
                  { key: "warnings", label: "Warnings" },
                  { key: "trace", label: "Trace" },
                ]}
                rows={reportRows.map((item) => ({
                  time: formatDateTime(item.createdAt),
                  scope: (
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-text-primary">{item.storeId || "-"}</p>
                      <p className="truncate text-xs text-text-muted">{item.operatorId || "-"}</p>
                      <p className="text-xs text-text-muted">{item.mode}</p>
                    </div>
                  ),
                  decision: <StatusPill tone={decisionTone(item.decision)} label={item.decision} />,
                  source: (
                    <div>
                      <p className="text-sm text-text-primary">{item.source}</p>
                      <p className="text-xs text-text-muted">{item.detectionType}</p>
                    </div>
                  ),
                  suggested: (
                    <div className="min-w-0">
                      <p className="font-medium text-text-primary">
                        {item.suggestedTitle || item.suggestedVariantId || "-"}
                      </p>
                      <p className="font-mono text-xs text-text-muted">{item.suggestedSku}</p>
                      <p className="truncate font-mono text-xs text-text-muted">
                        {item.suggestedVariantId || "-"}
                      </p>
                    </div>
                  ),
                  selected: (
                    <div className="min-w-0">
                      <p className="font-medium text-text-primary">
                        {item.selectedTitle || item.selectedVariantId || "-"}
                      </p>
                      <p className="font-mono text-xs text-text-muted">
                        {item.selectedSku || item.correctionType}
                      </p>
                      <p className="truncate font-mono text-xs text-text-muted">
                        {item.selectedVariantId || "-"}
                      </p>
                    </div>
                  ),
                  confidence: formatConfidence(item.confidence),
                  provider: (
                    <div className="min-w-0">
                      <p className="font-medium text-text-primary">
                        {item.provider} · {item.latencyMs}ms
                      </p>
                      <p className="truncate font-mono text-xs text-text-muted">{item.modelVersion || "-"}</p>
                    </div>
                  ),
                  warnings:
                    item.warnings.length > 0 ? (
                      <span className="text-xs text-status-warning">{item.warnings.join(", ")}</span>
                    ) : (
                      <span className="text-xs text-text-muted">-</span>
                    ),
                  trace: (
                    <div className="min-w-0 max-w-56">
                      <p className="break-all font-mono text-xs text-text-primary">{item.scanId}</p>
                      <p className="font-mono text-xs text-text-muted">{item.candidateCount} cand.</p>
                      <p className="truncate font-mono text-xs text-text-muted">{item.objectId}</p>
                      <p className="truncate font-mono text-xs text-text-muted">{item.imageHash}</p>
                    </div>
                  ),
                }))}
              />
            </PaginatedListFrame>
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}
