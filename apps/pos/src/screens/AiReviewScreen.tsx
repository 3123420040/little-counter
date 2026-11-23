import { useEffect, useMemo, useState } from "react";
import {
  Badge, Button, ConfirmDialog, InlineError, PaginatedListFrame, loadedListPaginationMeta, MutationBanner,
  PageHeader, Panel, TableSkeleton,
} from "@medusa-snus/ui";
import { fetchAiReviewQueue, approveAiAction, rejectAiAction } from "../api/endpoints";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, X } from "lucide-react";
import { useI18n } from "../i18n";

export default function AiReviewScreen() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [mutationNotice, setMutationNotice] = useState<{ tone: "success" | "error" | "pending"; message: string } | null>(null);
  const [queuePage, setQueuePage] = useState(1);

  const { data: actions, isLoading, error, refetch } = useQuery({
    queryKey: ["aiReviewQueue"],
    queryFn: fetchAiReviewQueue,
    refetchInterval: 15_000,
  });

  const items = useMemo(() => actions?.data || [], [actions?.data]);
  const queuePageMeta = loadedListPaginationMeta(items.length, queuePage, 20);
  const visibleItems = items.slice((queuePageMeta.page - 1) * 20, queuePageMeta.page * 20);
  const selected = selectedId
    ? items.find((a: any) => a.id === selectedId)
    : null;

  useEffect(() => {
    if (isLoading) return;
    if (items.length === 0) {
      if (selectedId) {
        setSelectedId(null);
        setEditText("");
      }
      return;
    }
    if (!selectedId || !items.some((item: any) => String(item.id) === selectedId)) {
      const first = items[0] as any;
      setSelectedId(String(first.id));
      setEditText((first.outputPayload as any)?.responseText || "");
    }
  }, [isLoading, items, selectedId]);

  useEffect(() => {
    if (queuePage > queuePageMeta.page) setQueuePage(queuePageMeta.page);
  }, [queuePage, queuePageMeta.page]);

  const approveMutation = useMutation({
    mutationFn: ({ id, text }: { id: string; text?: string }) => approveAiAction(id, text),
    onMutate: () => setMutationNotice({ tone: "pending", message: "Đang phê duyệt đề xuất AI..." }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["aiReviewQueue"] });
      setSelectedId(null);
      setEditText("");
      setMutationNotice({ tone: "success", message: "Đã phê duyệt đề xuất AI." });
    },
    onError: (err) => {
      setMutationNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể phê duyệt đề xuất.",
      });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => rejectAiAction(id, reason),
    onMutate: () => setMutationNotice({ tone: "pending", message: "Đang từ chối đề xuất AI..." }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["aiReviewQueue"] });
      setSelectedId(null);
      setRejectOpen(false);
      setRejectReason("");
      setMutationNotice({ tone: "success", message: "Đã từ chối đề xuất AI." });
    },
    onError: (err) => {
      setMutationNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể từ chối đề xuất.",
      });
    },
  });

  if (error) {
    return (
      <div className="p-4">
        <InlineError message="Không thể tải đề xuất AI" onRetry={() => refetch()} stale />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 h-full lg:flex-row">
      {/* ── Queue ── */}
      <div className="w-full shrink-0 space-y-2 lg:w-[320px]">
        <PageHeader title={t("ai.title")} />
        {mutationNotice && (
          <MutationBanner
            tone={mutationNotice.tone}
            message={mutationNotice.message}
            actionLabel={mutationNotice.tone === "error" ? t("state.close") : undefined}
            onAction={() => setMutationNotice(null)}
          />
        )}
        <Panel title={t("ai.queue")}>
          <PaginatedListFrame
            label="Phân trang hàng đợi AI"
            rowNoun="đề xuất"
            meta={queuePageMeta}
            onPageChange={setQueuePage}
            showPagination={Boolean(!isLoading && items.length)}
          >
            {isLoading ? (
              <div className="p-3 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-12 rounded bg-surface-subtle animate-pulse" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="p-6 text-center">
                <Bot size={24} className="text-text-muted mb-2 mx-auto" />
                <p className="text-sm font-medium text-text-secondary">{t("ai.emptyQueue")}</p>
                <p className="text-xs text-text-muted mt-1">{t("ai.emptyExplanation")}</p>
              </div>
            ) : (
              <div className="p-2 space-y-1">
                {visibleItems.map((a: any) => (
                  <button
                    key={String(a.id)}
                    onClick={() => {
                      setSelectedId(String(a.id));
                      setEditText((a.outputPayload as any)?.responseText || "");
                    }}
                    className={[
                      "flex w-full items-start justify-between gap-2 rounded-md border px-3 py-2 text-xs transition-colors text-left",
                      selectedId === String(a.id)
                        ? "border-action-primary bg-surface-selected"
                        : "border-border-default hover:bg-surface-hover",
                    ].join(" ")}
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-text-primary capitalize">
                        {String(a.actionType).replaceAll("_", " ")}
                      </p>
                      <p className="mt-0.5 text-[11px] text-text-muted">
                        {a.createdAt ? new Date(a.createdAt).toLocaleString("vi-VN") : "-"}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <Badge variant="risk" value={a.riskLevel || "medium"} />
                        <span className="text-[11px] text-text-muted">
                          {Math.round((Number(a.confidence) || 0) * 100)}%
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </PaginatedListFrame>
        </Panel>
      </div>

      {/* ── Detail ── */}
      <div className="flex-1 min-w-0">
        {selected ? (
          <Panel title={t("ai.draft")}>
            <div className="p-4 space-y-4 text-sm">
              {/* AI Response */}
              <div className="rounded-lg bg-surface-subtle p-3">
                <p className="text-xs text-text-muted mb-1">{t("ai.draft")}:</p>
                <p className="text-text-primary whitespace-pre-wrap">
                  {(selected.outputPayload as any)?.responseText || "-"}
                </p>
              </div>

              {/* Confidence + Risk */}
              <div className="flex items-center gap-3 text-xs text-text-muted">
                <span>
                  {t("ai.confidence")}: {Math.round((Number(selected.confidence) || 0) * 100)}%
                </span>
                <Badge variant="risk" value={selected.riskLevel || "medium"} />
              </div>

              {/* Edit */}
              <textarea
                aria-label="Edit response"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                placeholder={t("ai.editContent")}
                className="h-24 w-full rounded-md border border-border-default bg-surface-panel p-3 text-sm
                           focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20
                           resize-y"
              />

              {/* Actions */}
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={approveMutation.isPending || rejectMutation.isPending}
                  onClick={() =>
                    approveMutation.mutate({
                      id: String(selected.id),
                      text: editText || undefined,
                    })
                  }
                >
                  <Check size={14} className="mr-1" /> {t("ai.approve")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={approveMutation.isPending || rejectMutation.isPending}
                  onClick={() => setRejectOpen(true)}
                >
                  <X size={14} className="mr-1" /> {t("ai.reject")}
                </Button>
              </div>
            </div>
          </Panel>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-text-muted">
            <Bot size={32} className="mb-3" />
            <p className="text-sm font-medium">{t("ai.selectToReview")}</p>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={rejectOpen && !!selected}
        title={t("ai.reject")}
        confirmLabel={t("ai.reject")}
        danger
        pending={rejectMutation.isPending}
        onCancel={() => { setRejectOpen(false); setRejectReason(""); }}
        onConfirm={() => {
          if (!selected) return;
          rejectMutation.mutate({
            id: String(selected.id),
            reason: rejectReason || t("ai.rejectSelf"),
          });
        }}
      >
        <textarea
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder={t("ai.rejectReason")}
          className="h-20 w-full rounded-md border border-border-default bg-surface-panel p-3 text-sm
                     focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
          autoFocus
        />
      </ConfirmDialog>
    </div>
  );
}
