import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { Camera, CheckCircle2, ImagePlus, Loader2, Package, Search, ShoppingCart, Trash2, Upload, XCircle } from "lucide-react";
import { Button, Drawer, InlineError } from "@medusa-snus/ui";
import {
  recordVisionScanCorrection,
  scanVisionProducts,
  type VisionCartContext,
  type VisionCandidateView,
  type VisionDetectionView,
  type VisionScanResultData,
} from "../api/endpoints";

const MAX_SCAN_IMAGE_DATA_URL_CHARS = 1_200_000;
const INITIAL_MAX_DIMENSION = 1600;
const MIN_MAX_DIMENSION = 900;
const MAX_SCAN_IMAGES = 4;

export interface VisionScanDrawerProps {
  open: boolean;
  onClose: () => void;
  onAcceptCandidate: (candidate: VisionCandidateView, context?: VisionCartContext) => void | Promise<void>;
  onManualFallback?: (context?: VisionManualFallbackContext) => void;
  onViewCart?: () => void;
}

export interface VisionManualFallbackContext {
  scanId: string;
  detectionId?: string;
  previousVariantId?: string;
}

interface ScanImage {
  id: string;
  name: string;
  dataUrl: string;
}

function clientScanId() {
  return `pos-vision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Không đọc được ảnh."));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Không đọc được ảnh."));
    image.src = src;
  });
}

function drawCompressedImage(image: HTMLImageElement, maxDimension: number, quality: number): string {
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Trình duyệt không hỗ trợ xử lý ảnh.");
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

async function prepareImageForVision(file: File): Promise<string> {
  const original = await readAsDataUrl(file);
  if (original.length <= MAX_SCAN_IMAGE_DATA_URL_CHARS) return original;

  const image = await loadImage(original);
  for (let maxDimension = INITIAL_MAX_DIMENSION; maxDimension >= MIN_MAX_DIMENSION; maxDimension -= 180) {
    for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58]) {
      const compressed = drawCompressedImage(image, maxDimension, quality);
      if (compressed.length <= MAX_SCAN_IMAGE_DATA_URL_CHARS) return compressed;
    }
  }
  return drawCompressedImage(image, MIN_MAX_DIMENSION, 0.5);
}

function formatMoney(amount: number) {
  return `${Number(amount || 0).toLocaleString("vi-VN")} ₫`;
}

function confidenceLabel(confidence: number) {
  return `${Math.round(Math.max(0, Math.min(1, confidence || 0)) * 100)}%`;
}

function detectionTitle(detection: VisionDetectionView) {
  if (detection.detectionType === "exact_match") return "Match chính xác";
  if (detection.detectionType === "candidate_match") return "Gợi ý cần xác nhận";
  return "Chưa nhận diện được";
}

function sourceLabel(source: VisionCandidateView["source"]) {
  if (source === "qr") return "QR";
  if (source === "barcode") return "Barcode";
  if (source === "vision_provider") return "AI";
  return "Manual";
}

function selectionKey(detection: VisionDetectionView, candidate: VisionCandidateView) {
  return `${detection.detectionId}:${candidate.variantId}`;
}

function imageId(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`;
}

function staffWarningLabel(warning: string) {
  const normalized = warning.trim();
  if (!normalized || normalized === "ocr_fuzzy_match" || normalized.startsWith("image_")) return null;
  if (normalized === "provider_timeout") return "AI quá thời gian phản hồi.";
  if (normalized === "provider_unavailable") return "AI chưa sẵn sàng.";
  if (normalized === "provider_image_missing") return "Thiếu ảnh để scan.";
  if (normalized === "monthly_budget_exceeded") return "Đã vượt ngân sách scan tháng.";
  if (normalized.startsWith("provider_http_")) return "AI trả lỗi, hãy thử lại hoặc tìm thủ công.";
  return normalized.replace(/_/g, " ");
}

function staffWarnings(warnings: string[]) {
  return warnings.map(staffWarningLabel).filter((item): item is string => Boolean(item));
}

export function VisionScanDrawer({ open, onClose, onAcceptCandidate, onManualFallback, onViewCart }: VisionScanDrawerProps) {
  const [images, setImages] = useState<ScanImage[]>([]);
  const [activeImageId, setActiveImageId] = useState("");
  const [result, setResult] = useState<VisionScanResultData | null>(null);
  const [error, setError] = useState("");
  const [pendingScan, setPendingScan] = useState(false);
  const [pendingVariantId, setPendingVariantId] = useState("");
  const [addedVariantCounts, setAddedVariantCounts] = useState<Record<string, number>>({});
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const libraryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputId = useId();
  const libraryInputId = useId();

  useEffect(() => {
    if (open) return;
    setImages([]);
    setActiveImageId("");
    setResult(null);
    setError("");
    setPendingScan(false);
    setPendingVariantId("");
    setAddedVariantCounts({});
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    if (libraryInputRef.current) libraryInputRef.current.value = "";
  }, [open]);

  const activeImage = images.find((image) => image.id === activeImageId) || images[0] || null;
  const hasImages = images.length > 0;
  const detections = result?.detections || [];
  const addedTotal = Object.values(addedVariantCounts).reduce((sum, count) => sum + count, 0);
  const scanButtonLabel = pendingScan
    ? "Đang scan..."
    : hasImages
      ? `Scan ${images.length} ảnh`
      : "Scan ảnh";
  const manualFallbackDetection = detections.find((detection) => detection.decision !== "rejected") || detections[0] || null;
  const manualFallbackContext = result && manualFallbackDetection
    ? {
      scanId: result.scanId,
      detectionId: manualFallbackDetection.detectionId,
      previousVariantId: manualFallbackDetection.resolvedVariantId || undefined,
    }
    : undefined;

  async function appendFiles(files: File[]) {
    const imageFiles = files.filter((file) => !file.type || file.type.startsWith("image/"));
    if (imageFiles.length !== files.length) {
      setError("Một số file được chọn không phải ảnh.");
    }
    if (imageFiles.length === 0) return;

    const remainingSlots = MAX_SCAN_IMAGES - images.length;
    if (remainingSlots <= 0) {
      setError(`Mỗi lần scan tối đa ${MAX_SCAN_IMAGES} ảnh.`);
      return;
    }
    const acceptedFiles = imageFiles.slice(0, remainingSlots);
    if (acceptedFiles.length < imageFiles.length) {
      setError(`Đã nhận ${acceptedFiles.length} ảnh. Mỗi lần scan tối đa ${MAX_SCAN_IMAGES} ảnh.`);
    } else {
      setError("");
    }

    setResult(null);
    setPendingVariantId("");
    const prepared: ScanImage[] = [];
    for (const file of acceptedFiles) {
      prepared.push({
        id: imageId(file),
        name: file.name || "Ảnh scan",
        dataUrl: await prepareImageForVision(file),
      });
    }
    setImages((current) => [...current, ...prepared]);
    setActiveImageId(prepared[0]?.id || activeImageId);
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    try {
      await appendFiles(files);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không đọc được ảnh.");
    }
  }

  function clearSelectedImages() {
    setImages([]);
    setActiveImageId("");
    setResult(null);
    setError("");
    setPendingVariantId("");
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    if (libraryInputRef.current) libraryInputRef.current.value = "";
  }

  function removeImage(imageIdToRemove: string) {
    setImages((current) => {
      const next = current.filter((image) => image.id !== imageIdToRemove);
      setActiveImageId((currentActive) => (
        currentActive === imageIdToRemove ? next[0]?.id || "" : currentActive
      ));
      return next;
    });
    setResult(null);
    setError("");
    setPendingVariantId("");
  }

  async function handleScan() {
    if (!hasImages || pendingScan) return;
    setPendingScan(true);
    setError("");
    setResult(null);
    setPendingVariantId("");
    try {
      const imageBase64List = images.map((image) => image.dataUrl);
      const response = await scanVisionProducts({
        mode: "single",
        clientScanId: clientScanId(),
        imageBase64: imageBase64List[0],
        imageBase64List,
      });
      setResult(response.data);
      if (!response.data.detections.some((detection) => detection.candidates.length > 0)) {
        setError("Không có candidate đủ điều kiện. Hãy tìm sản phẩm thủ công.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không scan được ảnh.");
    } finally {
      setPendingScan(false);
    }
  }

  async function handleAccept(detection: VisionDetectionView, candidate: VisionCandidateView, candidateIndex: number) {
    const key = selectionKey(detection, candidate);
    if (!result || pendingVariantId || addedVariantCounts[key]) return;
    setPendingVariantId(key);
    setError("");
    try {
      const correctionType = candidate.variantId === detection.resolvedVariantId
        ? "staff_accepted"
        : "staff_selected_correct_variant";
      const correction = await recordVisionScanCorrection(result.scanId, {
        detectionId: detection.detectionId,
        selectedVariantId: candidate.variantId,
        previousVariantId: detection.resolvedVariantId || undefined,
        correctionType,
        metadata: {
          source: "pos_vision_drawer",
          confidence: candidate.confidence,
          candidateSource: candidate.source,
          selectedWhileDrawerOpen: true,
        },
      });
      await onAcceptCandidate(candidate, {
        scanEventId: result.scanId,
        detectionId: detection.detectionId,
        correctionId: correction.data.correctionId,
        objectId: detection.objectId,
        candidateSource: "ai_candidate",
        provider: result.provider,
        providerCandidateRank: candidateIndex + 1,
        providerConfidence: candidate.confidence,
        providerProductRef: candidate.providerProductRef,
        providerImageRef: candidate.providerImageRef,
      });
      setAddedVariantCounts((current) => ({
        ...current,
        [key]: (current[key] || 0) + 1,
      }));
      setResult({
        ...result,
        detections: result.detections.map((item) => (
          item.detectionId === detection.detectionId
            ? {
              ...item,
              decision: correctionType === "staff_accepted" ? "accepted" : "corrected",
              resolvedVariantId: candidate.variantId,
            }
            : item
        )),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không thêm được sản phẩm từ kết quả AI.");
    } finally {
      setPendingVariantId("");
    }
  }

  async function handleReject(detection: VisionDetectionView) {
    if (!result || pendingVariantId) return;
    setPendingVariantId(`reject-${detection.detectionId}`);
    setError("");
    try {
      await recordVisionScanCorrection(result.scanId, {
        detectionId: detection.detectionId,
        previousVariantId: detection.resolvedVariantId || undefined,
        correctionType: "staff_rejected",
        metadata: { source: "pos_vision_drawer" },
      });
      setResult({
        ...result,
        detections: result.detections.map((item) => (
          item.detectionId === detection.detectionId ? { ...item, decision: "rejected" } : item
        )),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không ghi được phản hồi reject.");
    } finally {
      setPendingVariantId("");
    }
  }

  function handleViewCart() {
    if (onViewCart) {
      onViewCart();
      return;
    }
    onClose();
  }

  return (
    <Drawer
      open={open}
      title="AI scan ảnh"
      subtitle="Chụp một hoặc nhiều ảnh, chọn đúng sản phẩm rồi mở giỏ để chỉnh số lượng."
      size="wide"
      onClose={onClose}
      actions={(
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          {addedTotal > 0 && (
            <Button
              variant="primary"
              size="lg"
              icon={<ShoppingCart size={17} aria-hidden="true" />}
              onClick={handleViewCart}
              className="w-full sm:w-auto"
            >
              Xem giỏ ({addedTotal})
            </Button>
          )}
          {onManualFallback && (
            <Button
              variant="secondary"
              size="md"
              icon={<Search size={15} aria-hidden="true" />}
              onClick={() => {
                onManualFallback(manualFallbackContext);
                onClose();
              }}
              disabled={pendingScan || Boolean(pendingVariantId)}
              className="w-full sm:w-auto"
            >
              Tìm thủ công
            </Button>
          )}
          <Button variant="secondary" size="md" onClick={onClose} disabled={pendingScan || Boolean(pendingVariantId)} className="w-full sm:w-auto">
            Đóng
          </Button>
          <Button
            variant="primary"
            size="lg"
            icon={pendingScan ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <Camera size={16} aria-hidden="true" />}
            onClick={() => void handleScan()}
            disabled={!hasImages || pendingScan || Boolean(pendingVariantId)}
            className="w-full sm:w-auto"
          >
            {scanButtonLabel}
          </Button>
        </div>
      )}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
        <div className="space-y-3">
          <div className="rounded-md border border-border-default bg-surface-subtle p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label htmlFor={cameraInputId} className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <ImagePlus size={16} aria-hidden="true" />
                Ảnh sản phẩm
              </label>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Camera size={14} aria-hidden="true" />}
                  onClick={() => cameraInputRef.current?.click()}
                  disabled={pendingScan || Boolean(pendingVariantId) || images.length >= MAX_SCAN_IMAGES}
                >
                  Chụp ảnh
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Upload size={14} aria-hidden="true" />}
                  onClick={() => libraryInputRef.current?.click()}
                  disabled={pendingScan || Boolean(pendingVariantId) || images.length >= MAX_SCAN_IMAGES}
                >
                  Thư viện
                </Button>
                {hasImages && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={14} aria-hidden="true" />}
                    onClick={clearSelectedImages}
                    disabled={pendingScan || Boolean(pendingVariantId)}
                  >
                    Xóa tất cả
                  </Button>
                )}
              </div>
            </div>
            <input
              id={cameraInputId}
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(event) => void handleFileChange(event)}
            />
            <input
              id={libraryInputId}
              ref={libraryInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => void handleFileChange(event)}
            />
            <div className="mt-3 flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-md border border-border-default bg-surface-panel">
              {activeImage ? (
                <img src={activeImage.dataUrl} alt={activeImage.name} className="h-full w-full object-contain" />
              ) : (
                <div className="flex flex-col items-center gap-2 text-text-muted">
                  <Package size={28} aria-hidden="true" />
                  <span className="text-xs">Chưa chọn ảnh</span>
                </div>
              )}
            </div>
            {hasImages && (
              <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Ảnh đã chọn">
                {images.map((image, index) => (
                  <div key={image.id} className="relative shrink-0">
                    <button
                      type="button"
                      className={[
                        "size-16 overflow-hidden rounded-md border bg-surface-panel",
                        image.id === activeImage?.id ? "border-action-primary ring-2 ring-action-primary/20" : "border-border-default",
                      ].join(" ")}
                      onClick={() => setActiveImageId(image.id)}
                      aria-label={`Xem ảnh ${index + 1}`}
                    >
                      <img src={image.dataUrl} alt="" className="h-full w-full object-cover" />
                    </button>
                    <button
                      type="button"
                      className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full border border-border-default bg-surface-panel text-text-muted shadow-sm"
                      onClick={() => removeImage(image.id)}
                      aria-label={`Xóa ảnh ${index + 1}`}
                      disabled={pendingScan || Boolean(pendingVariantId)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
              <span>{images.length}/{MAX_SCAN_IMAGES} ảnh</span>
              <span>Chỉ chụp sản phẩm; tránh mặt người, giấy tờ và thẻ thanh toán.</span>
            </div>
          </div>
          {error && <InlineError message={error} onRetry={() => setError("")} />}
          {addedTotal > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-status-success-border bg-status-success-bg px-3 py-2 text-sm text-status-success">
              <span className="flex items-center gap-2">
                <CheckCircle2 size={15} aria-hidden="true" />
                Đã thêm {addedTotal} sản phẩm vào giỏ.
              </span>
              <button type="button" className="font-semibold underline underline-offset-2" onClick={handleViewCart}>
                Xem giỏ
              </button>
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">Kết quả gợi ý</p>
              {result ? (
                <p className="mt-0.5 truncate text-xs text-text-muted">
                  {result.provider} · {result.status} · {result.scanId}
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-text-muted">
                  Sau khi scan, chọn từng sản phẩm đúng để thêm vào giỏ.
                </p>
              )}
            </div>
          </div>

          {!result && (
            <div className="rounded-md border border-dashed border-border-default bg-surface-subtle p-4 text-sm text-text-muted">
              Chưa có kết quả. Có thể chụp nhiều góc hoặc nhiều sản phẩm trong cùng một lần scan.
            </div>
          )}

          {detections.map((detection) => {
            const detectionWarnings = staffWarnings(detection.warnings);
            return (
              <section key={detection.detectionId} className="space-y-2">
                <div className="flex items-start justify-between gap-3 rounded-md border border-border-default bg-surface-panel px-3 py-2">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{detectionTitle(detection)}</p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {detection.confidence !== null ? `Độ tin cậy ${confidenceLabel(detection.confidence)}` : "Cần nhân viên kiểm tra"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<XCircle size={14} aria-hidden="true" />}
                    onClick={() => void handleReject(detection)}
                    disabled={pendingScan || Boolean(pendingVariantId) || detection.decision === "rejected"}
                  >
                    Reject
                  </Button>
                </div>

                {detectionWarnings.length > 0 && (
                  <div className="rounded-md border border-status-warning-border bg-status-warning-bg px-3 py-2 text-xs text-status-warning">
                    {detectionWarnings.join(" ")}
                  </div>
                )}

                {detection.candidates.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border-default p-3 text-sm text-text-muted">
                    Không có sản phẩm phù hợp.
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {detection.candidates.map((candidate, index) => {
                      const key = selectionKey(detection, candidate);
                      const isPending = pendingVariantId === key;
                      const addedCount = addedVariantCounts[key] || 0;
                      return (
                        <div
                          key={`${detection.detectionId}-${candidate.variantId}`}
                          className={[
                            "grid gap-3 rounded-md border p-2.5 sm:grid-cols-[72px_minmax(0,1fr)_132px] sm:items-center",
                            addedCount > 0
                              ? "border-status-success-border bg-status-success-bg"
                              : "border-border-default bg-surface-subtle",
                          ].join(" ")}
                        >
                          <div className="flex size-[72px] items-center justify-center overflow-hidden rounded-md border border-border-default bg-surface-panel">
                            {candidate.imageUrl ? (
                              <img src={candidate.imageUrl} alt={candidate.title} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                              <Package size={22} className="text-text-muted" aria-hidden="true" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="min-w-0 text-sm font-semibold leading-5 text-text-primary sm:text-base">{candidate.title}</p>
                              {index === 0 && (
                                <span className="rounded-full border border-status-success-border bg-status-success-bg px-2 py-0.5 text-[11px] font-semibold text-status-success">
                                  Top
                                </span>
                              )}
                              {addedCount > 0 && (
                                <span className="rounded-full border border-status-success-border bg-status-success-bg px-2 py-0.5 text-[11px] font-semibold text-status-success">
                                  Đã thêm
                                </span>
                              )}
                            </div>
                            <p className="mt-1 truncate font-mono text-xs text-text-muted">{candidate.sku || candidate.barcode || candidate.variantId}</p>
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
                              <span>{formatMoney(candidate.price)}</span>
                              <span>Còn {candidate.stock}</span>
                              <span>{sourceLabel(candidate.source)} {confidenceLabel(candidate.confidence)}</span>
                            </div>
                          </div>
                          <div className="flex items-center justify-end">
                            <Button
                              size="lg"
                              variant={addedCount > 0 ? "secondary" : "primary"}
                              icon={isPending ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <CheckCircle2 size={16} aria-hidden="true" />}
                              onClick={() => void handleAccept(detection, candidate, index)}
                              disabled={pendingScan || Boolean(pendingVariantId) || detection.decision === "rejected" || addedCount > 0}
                              className="w-full sm:w-32"
                            >
                              {addedCount > 0 ? "Đã thêm" : "Thêm"}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </Drawer>
  );
}
