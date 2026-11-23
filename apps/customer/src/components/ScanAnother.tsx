import { useEffect, useRef, useState } from "react";
import { BarcodeFormat, BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { X, ScanLine, Camera, ShoppingBag, ArrowRight } from "lucide-react";
import { scanGoLive } from "../scan-go/config";
import { MOCK_PRODUCTS } from "../scan-go/mockData";
import { extractQrSlug } from "../scan-go/config";
import { FormatTag } from "./FormatTag";

function cameraSupported(): boolean {
  if (typeof window === "undefined") return false;
  const hasMedia = Boolean(navigator?.mediaDevices?.getUserMedia);
  return hasMedia;
}

const SCAN_FORMATS = [BarcodeFormat.QR_CODE];

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Optional, progressive in-app scanner. Only ever mounted when supported. */
function InAppScanner({ onDetected, onError }: { onDetected: (slug: string) => void; onError: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const video = videoRef.current;
    if (!video) return;

    const stop = () => {
      cancelledRef.current = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
      video.srcObject = null;
    };

    (async () => {
      try {
        const reader = new BrowserMultiFormatReader();
        reader.possibleFormats = SCAN_FORMATS;
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } }, audio: false },
          video,
          (result) => {
            if (cancelledRef.current) return;
            const raw = result?.getText();
            const slug = raw ? extractQrSlug(raw) : null;
            if (!slug) return;
            stop();
            onDetected(slug);
          }
        );
        controlsRef.current = controls;
      } catch {
        onError();
      }
    })();

    return stop;
  }, [onDetected, onError]);

  return (
    <div className="relative overflow-hidden rounded-md bg-ink ring-1 ring-ink">
      <video ref={videoRef} playsInline muted className="aspect-[4/3] w-full object-cover" />
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="h-2/3 w-4/5 rounded-md border-2 border-dash" />
      </div>
    </div>
  );
}

/**
 * Post-add sheet: the "scan another" loop. Primary path is the normal phone
 * camera (instruction-first). The in-app camera is a progressive enhancement
 * shown only where supported, never required. Cart state is preserved by the
   * caller (it lives in sessionStorage across navigation in this tab).
 */
export function ScanAnother({
  open,
  onClose,
  onViewStash,
  onPickSlug,
}: {
  open: boolean;
  onClose: () => void;
  onViewStash: () => void;
  onPickSlug: (slug: string) => void;
}) {
  const [supported] = useState<boolean>(() => cameraSupported());
  const [scannerOpen, setScannerOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) setScannerOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    previousActiveRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !sheetRef.current) return;
      const focusable = Array.from(sheetRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousActiveRef.current?.focus?.();
      previousActiveRef.current = null;
    };
  }, [open, onClose]);

  if (!open) return null;

  const demos = Object.values(MOCK_PRODUCTS).filter((p) => p.availability === "available");

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center" role="dialog" aria-modal="true" aria-labelledby="scan-another-title">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-scrim backdrop-blur-[2px]"
      />
      <div ref={sheetRef} className="sd-pop relative w-full max-w-[440px] rounded-t-lg bg-card p-5 pb-[calc(20px+env(safe-area-inset-bottom))] shadow-lift">
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-pill bg-paper-deep" />
        <div className="flex items-start justify-between">
          <div>
            <h2 id="scan-another-title" className="text-xl font-extrabold tracking-tight text-ink">In your stash</h2>
            <p className="mt-1 text-sm text-ink-muted">Grab the next tag and keep going.</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-9 w-9 place-items-center rounded-full bg-paper-band text-ink-soft"
          >
            <X className="h-5 w-5" strokeWidth={2.5} />
          </button>
        </div>

        <div className="mt-4 rounded-md bg-paper-band p-4 ring-1 ring-inset ring-hairline">
          <div className="flex items-center gap-2 text-ink">
            <ScanLine className="h-5 w-5 text-dash" strokeWidth={2.5} />
            <span className="text-[15px] font-bold">Point your phone camera at the next shelf tag.</span>
          </div>
          {supported ? (
            <div className="mt-3">
              {scannerOpen ? (
                <InAppScanner
                  onDetected={(slug) => {
                    setScannerOpen(false);
                    onPickSlug(slug);
                  }}
                  onError={() => setScannerOpen(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setScannerOpen(true)}
                  className="inline-flex items-center gap-2 rounded-pill bg-card px-4 py-2 text-sm font-semibold text-ink ring-1 ring-inset ring-hairline"
                >
                  <Camera className="h-4 w-4" strokeWidth={2.5} />
                  Open in-app scanner
                </button>
              )}
            </div>
          ) : (
            <p className="mt-2 text-[13px] text-ink-muted">
              Your camera app opens this same page on the next tag. Your stash stays put.
            </p>
          )}
        </div>

        {!scanGoLive() && (
          <div className="mt-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-ink-muted">
              No tag handy? Try a demo tag
            </div>
            <div className="flex flex-wrap gap-2">
              {demos.map((p) => (
                <button
                  key={p.qrSlug}
                  type="button"
                  onClick={() => onPickSlug(p.qrSlug)}
                  className="inline-flex items-center gap-1.5 rounded-pill bg-card px-3 py-1.5 text-[13px] font-semibold text-ink ring-1 ring-inset ring-hairline active:scale-95 transition-transform"
                >
                  <span className="text-dash-deep">{p.brand}</span>
                  <span className="text-ink-soft">{p.name}</span>
                  <span className="ml-0.5"><FormatTag label={p.formatTags[0] ?? "POUCH"} /></span>
                </button>
              ))}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={onViewStash}
          className="mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-pill bg-ink text-[16px] font-bold text-paper active:scale-[0.98] transition-transform"
        >
          <ShoppingBag className="h-5 w-5" strokeWidth={2.5} />
          View stash
          <ArrowRight className="h-5 w-5" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
