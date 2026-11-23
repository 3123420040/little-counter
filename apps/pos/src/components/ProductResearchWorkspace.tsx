import { Button, Panel, StatusPill } from "@medusa-snus/ui";
import {
  CheckCircle2,
  ExternalLink,
  FileSearch,
  ShieldCheck,
  StickyNote,
} from "lucide-react";
import type { ProductResearchData, ProductResearchSource } from "../api/endpoints";

export type ProductResearchTab = "overview" | "sources" | "risks" | "notes";

interface ProductResearchWorkspaceProps {
  activeTab: ProductResearchTab;
  internalNote: string;
  loading: boolean;
  onCopyNote: () => void;
  onCreateTaskDraft: () => void;
  onInternalNoteChange: (value: string) => void;
  onTabChange: (tab: ProductResearchTab) => void;
  research: ProductResearchData | null;
}

const tabs: Array<{ key: ProductResearchTab; label: string }> = [
  { key: "overview", label: "Tổng quan" },
  { key: "sources", label: "Nguồn" },
  { key: "risks", label: "Rủi ro" },
  { key: "notes", label: "Ghi chú nội bộ" },
];

function formatDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("vi-VN");
}

function sourceDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function sourceExtract(source: ProductResearchSource) {
  return source.content?.trim() || source.snippet.trim() || "Nguồn chưa cung cấp đoạn nội dung có thể đọc trực tiếp.";
}

function sourcePreview(source: ProductResearchSource) {
  return source.snippet.trim() || source.content?.trim() || "Nguồn chưa cung cấp đoạn trích liên quan.";
}

function previewText(value: string, maxLength = 700) {
  return value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}...` : value;
}

function ProviderStatus({ provider }: { provider: string }) {
  const tavily = provider === "tavily";
  return (
    <span className={[
      "inline-flex items-center gap-1.5 text-xs font-medium",
      tavily ? "text-status-success" : "text-status-warning",
    ].join(" ")}>
      <span className={[
        "h-1.5 w-1.5 rounded-full",
        tavily ? "bg-status-success" : "bg-status-warning",
      ].join(" ")} />
      {tavily ? "Nguồn web Tavily" : "Kết quả local / mô phỏng"}
    </span>
  );
}

function coverageLabel(confidence: string) {
  if (confidence === "high") return "Phủ nguồn tốt";
  if (confidence === "medium") return "Cần đối chiếu";
  return "Thiếu nguồn phù hợp";
}

function riskLabel(flag: string) {
  const labels: Record<string, string> = {
    review_only: "Chỉ dùng để review nội bộ",
    do_not_auto_publish_claims: "Không tự đăng claim vào catalog",
    verify_nicotine_and_health_claims: "Xác minh nicotine và claim sức khỏe từ nguồn gốc",
    web_source_claims_unverified: "Claim từ web chưa được hệ thống xác thực",
  };
  return labels[flag] || flag;
}

function SourceLink({ source, rank, compact = false }: { source: ProductResearchSource; rank: number; compact?: boolean }) {
  const excerpt = sourcePreview(source);
  const fullExtract = sourceExtract(source);
  const hasExpandedExtract = !compact && fullExtract !== excerpt;
  return (
    <li className="border-b border-border-default py-4 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium text-text-muted">
            <span>#{source.rank || rank}</span>
            <span>{sourceDomain(source.url)}</span>
            {source.language && <span className="uppercase">{source.language}</span>}
          </div>
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-semibold text-action-primary hover:underline"
          >
            <span>{source.title}</span>
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        </div>
      </div>
      <p className={[
        "mt-2 whitespace-pre-wrap text-sm leading-6 text-text-secondary",
        compact ? "line-clamp-5" : "",
      ].join(" ")}>
        {compact ? previewText(excerpt) : excerpt}
      </p>
      {hasExpandedExtract && (
        <details className="mt-3 border-l-2 border-border-default pl-3 text-sm text-text-secondary">
          <summary className="cursor-pointer font-medium text-action-primary">Xem nội dung trích xuất đầy đủ</summary>
          <p className="mt-3 whitespace-pre-wrap leading-6">{fullExtract}</p>
        </details>
      )}
    </li>
  );
}

export function ProductResearchWorkspace({
  activeTab,
  internalNote,
  loading,
  onCopyNote,
  onCreateTaskDraft,
  onInternalNoteChange,
  onTabChange,
  research,
}: ProductResearchWorkspaceProps) {
  return (
    <Panel
      title="Kết quả research"
      action={(
        <div role="tablist" aria-label="Nội dung research" className="flex flex-wrap gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => onTabChange(tab.key)}
              className={[
                "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                activeTab === tab.key
                  ? "border-action-primary bg-surface-selected text-action-primary"
                  : "border-border-default bg-surface-panel text-text-secondary hover:bg-surface-hover",
              ].join(" ")}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
    >
      <div className="min-h-[420px] p-4 sm:p-5">
        {!research && !loading ? (
          <div className="flex min-h-[320px] flex-col items-center justify-center text-center">
            <FileSearch size={28} className="mb-3 text-text-muted" />
            <p className="text-sm font-semibold text-text-primary">Chưa có kết quả research cho sản phẩm này.</p>
            <p className="mt-1 max-w-md text-sm leading-6 text-text-muted">
              Chạy research để lấy tóm tắt, đoạn trích có nguồn, các điểm cần xác minh và ghi chú nội bộ.
            </p>
          </div>
        ) : loading && !research ? (
          <div aria-busy="true" aria-label="Đang tải kết quả research" className="space-y-4">
            <div className="h-20 animate-pulse rounded-md bg-surface-subtle" />
            <div className="h-28 animate-pulse rounded-md bg-surface-subtle" />
            <div className="h-28 animate-pulse rounded-md bg-surface-subtle" />
          </div>
        ) : research ? (
          <>
            {loading && (
              <div role="status" className="mb-4 flex items-center gap-2 border-b border-border-default pb-3 text-sm text-text-secondary">
                <span className="h-2 w-2 animate-pulse rounded-full bg-action-primary" />
                Đang cập nhật kết quả web mới. Kết quả hiện tại vẫn được giữ để tham chiếu.
              </div>
            )}

            {activeTab === "overview" && (
              <div className="space-y-6" role="tabpanel" aria-label="Tổng quan research">
                <section aria-labelledby="research-summary-heading">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone={research.status === "completed" ? "success" : "warning"} label={research.status} />
                    <StatusPill tone="info" label={coverageLabel(research.confidence)} />
                    <ProviderStatus provider={research.provider} />
                    <span className="text-xs text-text-muted">Cập nhật {formatDate(research.createdAt)}</span>
                  </div>
                  <div className="mt-4 border-l-2 border-action-primary pl-4">
                    <h3 id="research-summary-heading" className="text-sm font-semibold text-text-primary">Tóm tắt Tavily cần đối chiếu</h3>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-primary">{research.summary}</p>
                  </div>
                </section>

                {research.provider !== "tavily" && (
                  <div className="border-l-2 border-status-warning px-3 py-1 text-sm leading-6 text-text-secondary">
                    Kết quả này chưa phải dữ liệu web thực. Bật Tavily rồi chạy lại để đọc đoạn trích từ các nguồn bên ngoài.
                  </div>
                )}

                <section aria-labelledby="research-evidence-heading" className="border-t border-border-default pt-5">
                  <div className="mb-1 flex items-center gap-2">
                    <FileSearch size={16} className="text-text-muted" aria-hidden="true" />
                    <h3 id="research-evidence-heading" className="text-sm font-semibold text-text-primary">Nguồn tham chiếu đọc nhanh</h3>
                  </div>
                  <p className="mb-3 text-sm text-text-muted">Đoạn trích liên quan được lưu cùng run. Mở nguồn gốc trước khi dùng thông tin về nicotine, thành phần, xuất xứ hoặc sức khỏe.</p>
                  {research.sources.length ? (
                    <ol aria-label="Nguồn nổi bật" className="divide-y divide-border-default">
                      {research.sources.slice(0, 3).map((source, index) => (
                        <SourceLink key={`${source.url}-${index}`} source={source} rank={index + 1} compact />
                      ))}
                    </ol>
                  ) : (
                    <p className="text-sm text-text-muted">Chưa có nguồn đủ điều kiện cho truy vấn này. Hãy đổi tên/SKU sản phẩm hoặc chạy lại sau.</p>
                  )}
                </section>
              </div>
            )}

            {activeTab === "sources" && (
              <section role="tabpanel" aria-label="Nguồn research">
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-text-primary">Nguồn và nội dung trích xuất</h3>
                  <p className="mt-1 text-sm text-text-muted">Đọc nội dung tại đây, sau đó mở nguồn gốc để xác minh bối cảnh khi dùng claim cụ thể.</p>
                </div>
                {research.sources.length ? (
                  <ol aria-label="Danh sách nguồn research" className="divide-y divide-border-default">
                    {research.sources.map((source, index) => (
                      <SourceLink key={`${source.url}-${index}`} source={source} rank={index + 1} />
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-text-muted">Tavily chưa trả về nguồn có thể dùng cho truy vấn này.</p>
                )}
              </section>
            )}

            {activeTab === "risks" && (
              <section role="tabpanel" aria-label="Rủi ro research" className="space-y-5">
                <div className="border-l-2 border-status-warning pl-4">
                  <div className="flex items-center gap-2 text-status-warning">
                    <ShieldCheck size={17} aria-hidden="true" />
                    <h3 className="text-sm font-semibold">Review-only, không tự cập nhật catalog</h3>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                    Chỉ dùng kết quả như bằng chứng nội bộ. Tên, xuất xứ, nicotine, thành phần và lợi ích sức khỏe phải được đối chiếu với nguồn gốc trước khi đưa vào listing hoặc tư vấn khách.
                  </p>
                </div>
                <div className="border-t border-border-default pt-4">
                  <h3 className="text-sm font-semibold text-text-primary">Kiểm soát đang áp dụng</h3>
                  {research.riskFlags.length ? (
                    <ul className="mt-3 space-y-2" aria-label="Cờ rủi ro">
                      {research.riskFlags.map((flag) => (
                        <li key={flag} className="flex items-start gap-2 text-sm text-text-secondary">
                          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-status-warning" aria-hidden="true" />
                          <span>{riskLabel(flag)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 flex items-center gap-2 text-sm text-text-secondary">
                      <CheckCircle2 size={16} className="text-status-success" aria-hidden="true" />
                      Chưa phát hiện cảnh báo lớn từ nguồn hiện tại.
                    </p>
                  )}
                </div>
              </section>
            )}

            {activeTab === "notes" && (
              <section role="tabpanel" aria-label="Ghi chú nội bộ" className="space-y-3">
                <div className="flex items-center gap-2">
                  <StickyNote size={16} className="text-text-muted" aria-hidden="true" />
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">Ghi chú nội bộ</h3>
                    <p className="text-sm text-text-muted">Dùng để chuẩn bị nội dung review; chưa thay đổi catalog.</p>
                  </div>
                </div>
                <textarea
                  value={internalNote}
                  onChange={(event) => onInternalNoteChange(event.target.value)}
                  className="min-h-[280px] w-full resize-y rounded-md border border-border-default bg-surface-panel p-3 font-mono text-xs leading-5 focus:border-action-primary focus:outline-none"
                  aria-label="Ghi chú nội bộ"
                />
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={onCopyNote} disabled={!internalNote.trim()}>
                    Sao chép ghi chú nội bộ
                  </Button>
                  <Button variant="secondary" onClick={onCreateTaskDraft}>
                    Tạo nhiệm vụ cập nhật sản phẩm
                  </Button>
                </div>
              </section>
            )}
          </>
        ) : null}
      </div>
    </Panel>
  );
}
