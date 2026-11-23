import { useEffect, useId, useRef, useState } from "react";
import { BarcodeFormat, BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { Button, Drawer, InlineError } from "@medusa-snus/ui";
import { Camera, ImageOff, Keyboard, Loader2, Plus, QrCode, ScanLine, Search } from "lucide-react";
import {
  resolveProductScan,
  type ProductScanContext,
  type ProductScanResolution,
} from "../api/endpoints";

const SCAN_FORMATS = [
  BarcodeFormat.QR_CODE,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.DATA_MATRIX,
];

export interface StaffScanSearchProduct {
  id: string;
  title: string;
  imageUrl?: string;
  variants: Array<{
    id: string;
    sku: string;
    barcode?: string;
    prices: Array<{ amount: number }>;
    inventory_quantity: number | null;
  }>;
}

export interface StaffScanDialogProps {
  open: boolean;
  title: string;
  context?: ProductScanContext;
  onResolved?: (resolution: ProductScanResolution) => void;
  onRawCode?: (code: string) => Promise<boolean | void> | boolean | void;
  onClose: () => void;
  subtitle?: string;
  inputLabel?: string;
  placeholder?: string;
  submitLabel?: string;
  autoStartCamera?: boolean;
  cameraFirst?: boolean;
  manualEntry?: boolean;
  productSearch?: {
    value: string;
    products: StaffScanSearchProduct[];
    isLoading?: boolean;
    error?: boolean;
    onChange: (value: string) => void;
    onSelectVariant: (variantId: string) => void;
  };
}

export function StaffScanDialog({
  open,
  title,
  context,
  onResolved,
  onRawCode,
  onClose,
  subtitle,
  inputLabel,
  placeholder,
  submitLabel,
  autoStartCamera = false,
  cameraFirst = false,
  manualEntry = true,
  productSearch,
}: StaffScanDialogProps) {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [cameraActive, setCameraActive] = useState(false);
  const inputId = useId();
  const productSearchId = useId();
  const helperId = useId();
  const errorId = useId();
  const cameraErrorId = useId();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const autoStartAttemptedRef = useRef(false);
  const pendingRef = useRef(false);
  const lastSubmittedRef = useRef<{ code: string; at: number } | null>(null);

  function stopCamera() {
    controlsRef.current?.stop();
    controlsRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
  }

  useEffect(() => {
    if (!open) {
      stopCamera();
      setCode("");
      setError("");
      setCameraError("");
      autoStartAttemptedRef.current = false;
      pendingRef.current = false;
      lastSubmittedRef.current = null;
    }
    return () => stopCamera();
  }, [open]);

  useEffect(() => {
    if (!open || !autoStartCamera || autoStartAttemptedRef.current) return;
    autoStartAttemptedRef.current = true;
    void startCamera();
  }, [open, autoStartCamera]);

  async function submit(nextCode = code) {
    const trimmed = nextCode.trim();
    if (pendingRef.current) return false;
    if (!trimmed) {
      setError("Nhập hoặc scan QR/SKU trước.");
      return false;
    }
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      let shouldClose = true;
      if (onRawCode) {
        const result = await onRawCode(trimmed);
        shouldClose = result !== false;
      } else {
        if (!context || !onResolved) throw new Error("Scanner context is not configured.");
        const result = await resolveProductScan({ code: trimmed, context });
        onResolved(result.data);
      }
      if (!shouldClose) return false;
      setCode("");
      stopCamera();
      onClose();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không resolve được mã scan.");
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function startCamera() {
    if (controlsRef.current || cameraActive) return;
    setCameraError("");
    if (!navigator.mediaDevices?.getUserMedia || !videoRef.current) {
      setCameraError(manualEntry
        ? "Trình duyệt này chưa mở được camera. Hãy dán URL QR, SKU hoặc barcode vào ô bên dưới."
        : productSearch
          ? "Trình duyệt này chưa mở được camera. Dùng ô tìm sản phẩm bên dưới để thêm thủ công."
          : "Trình duyệt này chưa mở được camera. Đóng cửa sổ này và dùng ô tìm sản phẩm ở màn Bán hàng để thêm thủ công.");
      return;
    }
    try {
      const reader = new BrowserMultiFormatReader();
      reader.possibleFormats = SCAN_FORMATS;
      const controls = await reader.decodeFromConstraints(
        {
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        },
        videoRef.current,
        (result) => {
          const raw = result?.getText().trim();
          if (!raw || pendingRef.current) return;
          const now = Date.now();
          const last = lastSubmittedRef.current;
          if (last?.code === raw && now - last.at < 1500) return;
          lastSubmittedRef.current = { code: raw, at: now };
          setCode(raw);
          stopCamera();
          void submit(raw);
        },
      );
      controlsRef.current = controls;
      setCameraActive(true);
    } catch (err) {
      stopCamera();
      setCameraError(err instanceof Error ? err.message : "Không mở được camera.");
    }
  }

  return (
    <Drawer
      open={open}
      title={title}
      subtitle={subtitle || (cameraFirst ? undefined : context === "inventory_check" ? "Scan để mở nhanh sản phẩm tồn kho." : "Scan để thêm nhanh vào giỏ POS.")}
      onClose={onClose}
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>Đóng</Button>
          {manualEntry && (
            <Button
              variant="primary"
              icon={<ScanLine size={16} aria-hidden="true" />}
              onClick={() => void submit()}
              disabled={pending || !code.trim()}
            >
              {pending ? "Đang xử lý..." : submitLabel || "Resolve"}
            </Button>
          )}
        </>
      )}
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-border-default bg-surface-subtle p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Camera size={16} aria-hidden="true" />
              {cameraFirst ? "Camera scan" : "Camera"}
            </div>
            {(!cameraFirst || cameraActive || cameraError) && (
              <Button
                size="sm"
                variant={cameraActive ? "secondary" : "primary"}
                icon={<QrCode size={14} aria-hidden="true" />}
                onClick={() => cameraActive ? stopCamera() : void startCamera()}
              >
                {cameraActive ? "Tắt camera" : cameraError ? "Thử lại" : "Mở camera"}
              </Button>
            )}
          </div>
          <video
            ref={videoRef}
            muted
            playsInline
            className={[
              "aspect-[4/3] w-full rounded-md border border-border-default bg-black object-cover",
              cameraActive ? "" : "hidden",
            ].join(" ")}
          />
          {!cameraActive && (
            <p className="text-xs leading-5 text-text-muted">
              {cameraFirst && !cameraError
                ? "Đang mở camera..."
                : manualEntry
                  ? "Có thể dùng camera để đọc QR/SKU/barcode. Nếu không, dán URL QR/SKU/barcode ở bên dưới."
                  : productSearch
                    ? "Đưa camera vào QR sản phẩm hoặc QR tổng của khách. Nếu scan không được, gõ nhanh tên, SKU hoặc barcode ở bên dưới."
                    : "Đưa camera vào QR sản phẩm hoặc QR tổng của khách. Nếu scan không được, đóng cửa sổ này và dùng ô tìm sản phẩm."}
            </p>
          )}
          {cameraError && <p id={cameraErrorId} role="alert" className="mt-2 text-xs text-status-warning">{cameraError}</p>}
        </div>

        {productSearch && (
          <div className="rounded-lg border border-border-default bg-surface-panel p-3">
            <label htmlFor={productSearchId} className="mb-2 flex items-center gap-2 text-xs font-semibold text-text-secondary">
              <Search size={14} aria-hidden="true" />
              Tìm sản phẩm / SKU / barcode
            </label>
            <input
              id={productSearchId}
              type="search"
              inputMode="search"
              value={productSearch.value}
              onChange={(event) => productSearch.onChange(event.target.value)}
              className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm text-text-primary placeholder:text-text-muted focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
              placeholder="Gõ tên, SKU, barcode..."
            />
            <div className="mt-2 max-h-56 overflow-y-auto overscroll-contain pr-1">
              {productSearch.value.trim().length === 0 ? (
                <p className="rounded-md bg-surface-subtle px-3 py-2 text-xs leading-5 text-text-muted">
                  Gõ từ khoá để tìm và thêm sản phẩm khi camera không dùng được.
                </p>
              ) : productSearch.isLoading ? (
                <div className="flex items-center gap-2 rounded-md bg-surface-subtle px-3 py-2 text-xs text-text-muted">
                  <Loader2 size={14} className="spin" aria-hidden="true" />
                  Đang tìm sản phẩm...
                </div>
              ) : productSearch.error ? (
                <p className="rounded-md bg-status-danger-bg px-3 py-2 text-xs text-status-danger">
                  Không thể tìm sản phẩm. Kiểm tra kết nối rồi thử lại.
                </p>
              ) : productSearch.products.length === 0 ? (
                <p className="rounded-md bg-surface-subtle px-3 py-2 text-xs text-text-muted">
                  Không tìm thấy sản phẩm phù hợp.
                </p>
              ) : (
                <div className="space-y-2">
                  {productSearch.products.slice(0, 8).map((product) => {
                    const variant = product.variants?.[0];
                    if (!variant) return null;
                    const price = variant.prices?.[0]?.amount || 0;
                    return (
                      <button
                        key={`${product.id}-${variant.id}`}
                        type="button"
                        onClick={() => {
                          stopCamera();
                          productSearch.onSelectVariant(variant.id);
                        }}
                        className="flex w-full items-center gap-2 rounded-md border border-border-default bg-surface-panel p-2 text-left transition-colors hover:bg-surface-hover"
                        aria-label={`Thêm ${product.title}`}
                      >
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-subtle text-text-muted">
                          {product.imageUrl ? (
                            <img src={product.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" />
                          ) : (
                            <ImageOff size={15} aria-hidden="true" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-text-primary">{product.title}</p>
                          <p className="mt-0.5 truncate text-xs text-text-muted">
                            {variant.sku || variant.barcode || "Không SKU"} · {price.toLocaleString("vi-VN")} ₫
                          </p>
                        </div>
                        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-default text-action-primary">
                          <Plus size={15} aria-hidden="true" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {manualEntry && <div>
          <label htmlFor={inputId} className="mb-1 flex items-center gap-2 text-xs text-text-muted">
            <Keyboard size={14} aria-hidden="true" />
            {inputLabel || "QR URL, SKU hoặc barcode"}
          </label>
          <textarea
            id={inputId}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !pendingRef.current) void submit();
            }}
            rows={4}
            aria-describedby={[helperId, cameraError ? cameraErrorId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined}
            aria-invalid={Boolean(error)}
            className="w-full resize-none rounded-md border border-border-default bg-surface-panel px-3 py-2 font-mono text-sm focus:border-action-primary focus:outline-none"
            placeholder={placeholder || "https://.../scan/... hoặc SKU/barcode"}
          />
          <p id={helperId} className="sr-only">
            Cmd/Ctrl + Enter để resolve nhanh.
          </p>
        </div>}

        {error && <div id={errorId} role="alert"><InlineError message={error} onRetry={() => setError("")} /></div>}
      </div>
    </Drawer>
  );
}
