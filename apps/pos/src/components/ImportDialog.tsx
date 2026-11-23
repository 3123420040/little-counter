import { useEffect, useState, useRef } from "react";
import { AlertCircle, UploadCloud, CheckCircle, XCircle } from "lucide-react";
import { Button, PaginatedListFrame, localListPaginationMeta, OperationalTable, StatusPill, InlineError, type StatusTone } from "@medusa-snus/ui";
import {
  previewImport,
  applyImport,
  type CsvDownloadResource,
  type ImportPreviewResult,
  type ImportApplyResult,
} from "../api/endpoints";

export interface ImportDialogProps {
  open: boolean;
  resource: CsvDownloadResource;
  onClose: () => void;
  onSuccess: () => void;
}

const RESOURCE_LABELS: Record<CsvDownloadResource, string> = {
  products: "Sản phẩm",
  categories: "Danh mục",
  inventory: "Điều chỉnh tồn kho",
  purchaseOrders: "Đơn nhập hàng (Draft)",
};

type PreviewRow = ImportPreviewResult["rows"][number];
type ApplyRow = ImportApplyResult["rows"][number];

function previewStatusTone(status: PreviewRow["status"]): StatusTone {
  if (status === "valid") return "success";
  if (status === "warning") return "warning";
  return "danger";
}

function applyStatusTone(status: ApplyRow["status"]): StatusTone {
  return status === "applied" ? "success" : "danger";
}

export function ImportDialog({ open, resource, onClose, onSuccess }: ImportDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [applyResult, setApplyResult] = useState<ImportApplyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [applyPage, setApplyPage] = useState(1);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    setPreview(null);
    setApplyResult(null);
    setError(null);
    setPreviewPage(1);
    setApplyPage(1);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setError(null);
    setLoading(true);

    try {
      const text = await selected.text();
      const res = await previewImport(resource, text);
      setPreview(res.data);
      setPreviewPage(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi khi đọc file");
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleApply() {
    if (!file || !preview?.valid) return;
    setLoading(true);
    setError(null);
    try {
      const text = await file.text();
      const res = await applyImport(resource, text, preview.importId);
      setApplyResult(res.data);
      setApplyPage(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi khi apply import");
    } finally {
      setLoading(false);
    }
  }

  const previewPageMeta = localListPaginationMeta(preview?.rows.length || 0, previewPage, 20);
  const visiblePreviewRows = (preview?.rows || []).slice((previewPageMeta.page - 1) * 20, previewPageMeta.page * 20);
  const applyPageMeta = localListPaginationMeta(applyResult?.rows.length || 0, applyPage, 20);
  const visibleApplyRows = (applyResult?.rows || []).slice((applyPageMeta.page - 1) * 20, applyPageMeta.page * 20);

  useEffect(() => {
    if (previewPage > previewPageMeta.page) setPreviewPage(previewPageMeta.page);
  }, [previewPage, previewPageMeta.page]);
  useEffect(() => {
    if (applyPage > applyPageMeta.page) setApplyPage(applyPageMeta.page);
  }, [applyPage, applyPageMeta.page]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40" onClick={handleClose}>
      <div
        className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-xl bg-surface-panel p-6 shadow-lg animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold text-text-primary">
            Import {RESOURCE_LABELS[resource]}
          </h2>
          <button onClick={handleClose} className="text-text-secondary hover:text-text-primary">
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 space-y-4">
          {error && <InlineError message={error} />}

          {!applyResult && (
            <div className="p-4 border-2 border-dashed border-ui-border rounded-lg text-center flex flex-col items-center gap-2">
              <UploadCloud className="text-text-secondary" size={32} />
              <p className="text-sm text-text-secondary">Chọn file CSV để xem trước dữ liệu</p>
              <input
                type="file"
                accept=".csv"
                className="hidden"
                ref={fileInputRef}
                onChange={(e) => void handleFileChange(e)}
              />
              <Button onClick={() => fileInputRef.current?.click()} disabled={loading}>
                {loading ? "Đang xử lý..." : "Chọn File CSV"}
              </Button>
              {file && <p className="text-xs text-text-primary font-medium">{file.name}</p>}
            </div>
          )}

          {preview && !applyResult && (
            <div className="space-y-4">
              <div className="flex gap-4 p-4 bg-ui-surface rounded-lg">
                <div className="flex-1">
                  <p className="text-xs text-text-secondary uppercase">Tổng số dòng</p>
                  <p className="text-lg font-bold">{preview.summary.totalRows}</p>
                </div>
                <div className="flex-1">
                  <p className="text-xs text-text-secondary uppercase text-status-success">Hợp lệ</p>
                  <p className="text-lg font-bold text-status-success">{preview.summary.validRows}</p>
                </div>
                <div className="flex-1">
                  <p className="text-xs text-text-secondary uppercase text-status-warning">Cảnh báo</p>
                  <p className="text-lg font-bold text-status-warning">{preview.summary.warningRows}</p>
                </div>
                <div className="flex-1">
                  <p className="text-xs text-text-secondary uppercase text-status-danger">Lỗi</p>
                  <p className="text-lg font-bold text-status-danger">{preview.summary.errorRows}</p>
                </div>
              </div>

              {preview.summary.totalRows > 0 && (
                <>
                <PaginatedListFrame
                  label="Phân trang xem trước import"
                  rowNoun="dòng"
                  meta={previewPageMeta}
                  onPageChange={setPreviewPage}
                >
                  <OperationalTable
                    columns={[
                      { key: "row", label: "Dòng" },
                      { key: "action", label: "Hành động" },
                      { key: "status", label: "Trạng thái" },
                      { key: "messages", label: "Chi tiết" },
                    ]}
                    rows={visiblePreviewRows.map((row) => ({
                      row: row.rowNumber,
                      action: row.action,
                      status: <StatusPill tone={previewStatusTone(row.status)} label={row.status} />,
                      messages: (
                        <div className="text-xs space-y-1">
                          {row.errors.map((message, index) => (
                            <div key={`error-${index}`} className="text-status-danger flex items-center gap-1">
                              <XCircle size={12} />
                              {message}
                            </div>
                          ))}
                          {row.warnings.map((message, index) => (
                            <div key={`warning-${index}`} className="text-status-warning flex items-center gap-1">
                              <AlertCircle size={12} />
                              {message}
                            </div>
                          ))}
                        </div>
                      ),
                    }))}
                  />
                </PaginatedListFrame>
                </>
              )}
            </div>
          )}

          {applyResult && (
            <div className="space-y-4">
              <div className="p-4 bg-status-success/10 border border-status-success/20 rounded-lg flex items-start gap-3">
                <CheckCircle className="text-status-success mt-0.5" size={20} />
                <div>
                  <h3 className="font-bold text-status-success">Import hoàn tất</h3>
                  <p className="text-sm mt-1">Đã xử lý thành công {applyResult.appliedRows} dòng.</p>
                  {applyResult.errorRows > 0 && (
                    <p className="text-sm text-status-danger">Lỗi: {applyResult.errorRows} dòng.</p>
                  )}
                </div>
              </div>

              <PaginatedListFrame
                label="Phân trang kết quả import"
                rowNoun="dòng"
                meta={applyPageMeta}
                onPageChange={setApplyPage}
              >
                <OperationalTable
                  columns={[
                    { key: "row", label: "Dòng" },
                    { key: "action", label: "Hành động" },
                    { key: "status", label: "Trạng thái" },
                    { key: "messages", label: "Chi tiết" },
                  ]}
                  rows={visibleApplyRows.map((row) => ({
                    row: row.rowNumber,
                    action: row.action,
                    status: <StatusPill tone={applyStatusTone(row.status)} label={row.status} />,
                    messages: (
                      <div className="text-xs space-y-1">
                        {row.errors.map((message, index) => (
                          <div key={`error-${index}`} className="text-status-danger flex items-center gap-1">
                            <XCircle size={12} />
                            {message}
                          </div>
                        ))}
                      </div>
                    ),
                  }))}
                />
              </PaginatedListFrame>
            </div>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-ui-border flex justify-end gap-2">
          {applyResult ? (
            <Button variant="primary" onClick={() => { onSuccess(); handleClose(); }}>
              Đóng
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={handleClose} disabled={loading}>Hủy</Button>
              <Button
                variant="primary"
                onClick={() => void handleApply()}
                disabled={loading || !file || !preview?.valid || preview.summary.totalRows === 0}
              >
                {loading ? "Đang xử lý..." : "Thực hiện Import"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
