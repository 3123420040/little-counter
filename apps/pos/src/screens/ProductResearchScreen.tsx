import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Button,
  InlineError,
  MutationBanner,
  PageHeader,
  Panel,
  ResponsiveMetricGrid,
  MetricCell,
  TableSkeleton,
} from "@medusa-snus/ui";
import {
  ArrowLeft,
  ExternalLink,
  RefreshCw,
  Search,
} from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { useAdminProduct } from "../hooks/useAdminProducts";
import {
  fetchLatestProductResearch,
  fetchSyncBootstrap,
  runProductResearch,
  updateProductResearchReview,
  type ProductResearchData,
} from "../api/endpoints";
import { ProductResearchWorkspace, type ProductResearchTab } from "../components/ProductResearchWorkspace";

function formatMoney(value: number | string | null | undefined) {
  const amount = Number(value || 0);
  return `${amount.toLocaleString("vi-VN")} ₫`;
}

function buildInternalNote(research: ProductResearchData | null) {
  if (!research) return "";
  const sourceLines = research.sources
    .slice(0, 5)
    .map((source, index) => `${index + 1}. ${source.title} - ${source.url}`)
    .join("\n");
  const riskLines = research.riskFlags.length
    ? research.riskFlags.map((flag) => `- ${flag}`).join("\n")
    : "- Chưa phát hiện cảnh báo lớn trong nguồn hiện có.";
  return [
    `Product research: ${research.productTitle}`,
    `Provider: ${research.provider}`,
    `Confidence: ${research.confidence}`,
    "",
    "Summary:",
    research.summary,
    "",
    "Risk flags:",
    riskLines,
    "",
    "Sources:",
    sourceLines || "- Chưa có nguồn.",
  ].join("\n");
}

export default function ProductResearchScreen() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { operator } = useAuth();
  const canManage = operator?.role === "manager" || operator?.role === "owner";
  const [featureEntitlements, setFeatureEntitlements] = useState<Set<string>>(new Set());
  const [research, setResearch] = useState<ProductResearchData | null>(null);
  const [researchLoading, setResearchLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ProductResearchTab>("overview");
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "pending"; message: string } | null>(null);
  const [internalNote, setInternalNote] = useState("");
  const productQuery = useAdminProduct(id || null);

  const canResearch = canManage && featureEntitlements.has("product_research");
  const product = productQuery.data;
  const variant = product?.variants?.[0];

  useEffect(() => {
    void fetchSyncBootstrap()
      .then((res) => {
        const features = res.data.entitlements?.data?.features || res.data.entitlements?.features || [];
        setFeatureEntitlements(new Set(features));
      })
      .catch(() => setFeatureEntitlements(new Set()));
  }, []);

  useEffect(() => {
    if (!id || !canResearch) return;
    let active = true;
    setResearchLoading(true);
    void fetchLatestProductResearch(id)
      .then((result) => {
        if (!active) return;
        setResearch(result.data);
        setInternalNote(buildInternalNote(result.data));
      })
      .catch(() => {
        if (active) setResearch(null);
      })
      .finally(() => {
        if (active) setResearchLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canResearch, id]);

  async function handleRunResearch() {
    if (!id || !canResearch) return;
    setResearchLoading(true);
    setNotice({ tone: "pending", message: "Đang research sản phẩm..." });
    try {
      const result = await runProductResearch(id);
      setResearch(result.data);
      setInternalNote(buildInternalNote(result.data));
      setActiveTab("overview");
      setNotice({ tone: "success", message: "Đã cập nhật kết quả research." });
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể research sản phẩm.",
      });
    } finally {
      setResearchLoading(false);
    }
  }

  async function handleCopyNote() {
    if (!internalNote.trim()) return;
    try {
      await navigator.clipboard.writeText(internalNote);
      setNotice({ tone: "success", message: "Đã copy ghi chú nội bộ." });
    } catch {
      setNotice({ tone: "error", message: "Không thể copy tự động. Hãy chọn và copy thủ công." });
    }
  }

  async function handleCreateTaskDraft() {
    if (!research?.runId) {
      setNotice({ tone: "error", message: "Chưa có kết quả research để tạo nháp nhiệm vụ." });
      return;
    }
    const taskDraft = {
      type: "product_research_review",
      productId: research.productId,
      productTitle: research.productTitle,
      sourceRunId: research.runId,
      createdAt: new Date().toISOString(),
    };
    try {
      const result = await updateProductResearchReview(research.runId, {
        operatorNotes: internalNote,
        operatorReviewStatus: "needs_follow_up",
        operatorTaskDraft: taskDraft,
      });
      setResearch((current) => current ? {
        ...current,
        operatorNotes: result.data.operatorNotes,
        operatorReviewStatus: result.data.operatorReviewStatus,
        operatorTaskDraft: result.data.operatorTaskDraft,
      } : current);
      setNotice({
        tone: "success",
        message: "Đã lưu nháp nhiệm vụ research. Chưa thay đổi catalog.",
      });
      setActiveTab("notes");
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể lưu nháp nhiệm vụ.",
      });
    }
  }

  if (!id) {
    return (
      <div className="p-4">
        <InlineError message="Thiếu product id." onRetry={() => navigate("/products")} stale />
      </div>
    );
  }

  if (productQuery.error) {
    return (
      <div className="p-4">
        <InlineError message="Không thể tải sản phẩm." onRetry={() => productQuery.refetch()} stale />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Research sản phẩm"
        subtitle={product ? `${product.title} ${variant?.sku ? `- ${variant.sku}` : ""}` : "Đang tải sản phẩm"}
        actions={(
          <>
            <Button variant="secondary" onClick={() => navigate("/products")}>
              <ArrowLeft size={14} className="mr-1" /> Sản phẩm
            </Button>
            {research?.bestSource && (
              <Button variant="secondary" onClick={() => window.open(research.bestSource?.url, "_blank", "noopener,noreferrer")}>
                <ExternalLink size={14} className="mr-1" /> Mở nguồn tốt nhất
              </Button>
            )}
            <Button variant="primary" onClick={handleRunResearch} disabled={researchLoading || !canResearch || productQuery.isLoading}>
              {researchLoading ? <RefreshCw size={14} className="mr-1 animate-spin" /> : <Search size={14} className="mr-1" />}
              {research ? "Research lại" : "Research"}
            </Button>
          </>
        )}
      />

      {notice && (
        <MutationBanner
          tone={notice.tone}
          message={notice.message}
          actionLabel={notice.tone === "error" ? "Đóng" : undefined}
          onAction={() => setNotice(null)}
        />
      )}

      {!canResearch && (
        <MutationBanner
          tone="error"
          message="Product research đang khóa cho package hiện tại hoặc operator không có quyền quản lý sản phẩm."
        />
      )}

      {productQuery.isLoading ? (
        <TableSkeleton rows={4} cols={4} />
      ) : product ? (
        <>
          <ResponsiveMetricGrid>
            <MetricCell label="SKU" value={variant?.sku || "-"} tone="info" />
            <MetricCell label="Giá bán" value={formatMoney(variant?.prices?.[0]?.amount || 0)} />
            <MetricCell label="Tồn" value={String(Number(variant?.inventory_quantity || 0))} tone={Number(variant?.inventory_quantity || 0) > 0 ? "success" : "warning"} />
            <MetricCell label="Danh mục" value={product.categories?.[0]?.name || "Chưa phân loại"} />
          </ResponsiveMetricGrid>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <ProductResearchWorkspace
              activeTab={activeTab}
              internalNote={internalNote}
              loading={researchLoading}
              onCopyNote={handleCopyNote}
              onCreateTaskDraft={handleCreateTaskDraft}
              onInternalNoteChange={setInternalNote}
              onTabChange={setActiveTab}
              research={research}
            />

            <div className="space-y-4">
              <Panel title="Phạm vi research">
                <div className="space-y-4 p-4 text-sm">
                  <div>
                    <p className="text-xs font-medium uppercase text-text-muted">Truy vấn đã chạy</p>
                    <p className="mt-1 break-words leading-6 text-text-primary">{research?.rawQuery || "Chạy lần đầu sẽ tự tạo từ tên sản phẩm."}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 border-t border-border-default pt-3">
                    <div>
                      <p className="text-xs text-text-muted">Provider</p>
                      <p className="mt-1 font-medium text-text-primary">{research?.provider || "-"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-text-muted">Nguồn</p>
                      <p className="mt-1 font-medium text-text-primary">{research?.sources.length || 0}</p>
                    </div>
                  </div>
                </div>
              </Panel>
              <Panel title="Nguyên tắc dùng thông tin">
                <div className="space-y-2 p-4 text-sm text-text-secondary">
                  <p>Không tự ghi claim, mô tả hoặc metadata vào catalog.</p>
                  <p>Ưu tiên nguồn tiếng Việt khi có; không giới hạn domain nhưng luôn cần đối chiếu nguồn gốc.</p>
                  <p>Operator phải review nguồn trước khi dùng cho nội bộ hoặc listing.</p>
                </div>
              </Panel>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
