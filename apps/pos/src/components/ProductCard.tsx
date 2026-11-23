import { ImageOff, Info, Package, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ProductCardProps {
  id: string;
  title: string;
  price: number;
  stockLevel: number;
  variantId: string;
  sku: string;
  imageUrl?: string;
  onSelect: (variantId: string) => void;
}

function stockBadge(level: number) {
  if (level === 0) return { text: "Hết", cls: "bg-status-danger-bg text-status-danger border-status-danger-border" };
  if (level <= 5) return { text: `Còn ${level}`, cls: "bg-status-warning-bg text-status-warning border-status-warning-border" };
  return { text: `Còn ${level}`, cls: "bg-status-success-bg text-status-success border-status-success-border" };
}

/* ── Hover Image Preview ───────────────────────────────────────────
 * UX rationale (based on Nielsen Norman Group / Material Design):
 * - 300ms hover delay prevents accidental popup on fly-by mouse movement
 * - Preview renders as a fixed-position portal so it floats above all content
 * - Position is computed relative to the card, placed to the right if space allows,
 *   otherwise to the left, and clamped to the viewport vertically
 * - 150ms fade-in transition for smooth appearance, instant dismiss on leave
 * - Only shows on non-touch (pointer: fine) devices via media query in CSS
 * ─────────────────────────────────────────────────────────────────── */

const HOVER_DELAY_MS = 300;
const PREVIEW_SIZE = 240;
const VIEWPORT_PADDING = 12;

function ImagePreviewPortal({ imageUrl, title, anchorRect }: {
  imageUrl: string;
  title: string;
  anchorRect: DOMRect;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    // Trigger fade-in on next frame for CSS transition
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Position: prefer right of card, fallback to left
  const spaceRight = window.innerWidth - anchorRect.right;
  const placeRight = spaceRight >= PREVIEW_SIZE + VIEWPORT_PADDING * 2;
  const left = placeRight
    ? anchorRect.right + VIEWPORT_PADDING
    : anchorRect.left - PREVIEW_SIZE - VIEWPORT_PADDING;
  // Vertically center on the card, clamped to viewport
  const rawTop = anchorRect.top + anchorRect.height / 2 - PREVIEW_SIZE / 2;
  const top = Math.max(VIEWPORT_PADDING, Math.min(rawTop, window.innerHeight - PREVIEW_SIZE - VIEWPORT_PADDING));

  return createPortal(
    <div
      role="img"
      aria-label={`Ảnh phóng to: ${title}`}
      className="product-image-preview"
      style={{
        position: "fixed",
        left: `${Math.max(VIEWPORT_PADDING, left)}px`,
        top: `${top}px`,
        width: `${PREVIEW_SIZE}px`,
        height: `${PREVIEW_SIZE}px`,
        zIndex: 9999,
        pointerEvents: "none",
        opacity: visible ? 1 : 0,
        transform: visible ? "scale(1)" : "scale(0.92)",
        transition: "opacity 150ms ease-out, transform 150ms ease-out",
      }}
    >
      <img
        src={imageUrl}
        alt={title}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          borderRadius: "12px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10)",
          border: "1px solid var(--border-default, #e5e5e5)",
          background: "var(--surface-panel, #fff)",
        }}
        referrerPolicy="no-referrer"
      />
      <span
        style={{
          position: "absolute",
          bottom: "-24px",
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: "11px",
          fontWeight: 600,
          color: "var(--text-primary, #1c1917)",
          background: "var(--surface-panel, #fff)",
          borderRadius: "6px",
          padding: "2px 8px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: `${PREVIEW_SIZE}px`,
        }}
      >
        {title}
      </span>
    </div>,
    document.body,
  );
}

export function ProductCard({ title, price, stockLevel, variantId, sku, imageUrl, onSelect }: ProductCardProps) {
  const sb = stockBadge(stockLevel);
  const [showDetails, setShowDetails] = useState(false);
  const [imgError, setImgError] = useState(false);
  const hasImage = !!imageUrl && !imgError;

  // Hover preview state
  const [showPreview, setShowPreview] = useState(false);
  const [previewRect, setPreviewRect] = useState<DOMRect | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (!hasImage) return;
    // Only show on devices with fine pointer (no touch)
    if (window.matchMedia("(pointer: fine)").matches === false) return;
    clearHoverTimer();
    hoverTimerRef.current = setTimeout(() => {
      if (cardRef.current) {
        setPreviewRect(cardRef.current.getBoundingClientRect());
        setShowPreview(true);
      }
    }, HOVER_DELAY_MS);
  }, [hasImage, clearHoverTimer]);

  const handleMouseLeave = useCallback(() => {
    clearHoverTimer();
    setShowPreview(false);
  }, [clearHoverTimer]);

  useEffect(() => {
    setImgError(false);
  }, [imageUrl]);

  useEffect(() => {
    return () => clearHoverTimer();
  }, [clearHoverTimer]);

  // The preview is positioned from a snapshot rect, so dismiss it on scroll or
  // resize to stop the floating image from drifting away from its card. Scroll
  // uses capture so nested scroll containers are caught as well.
  useEffect(() => {
    if (!showPreview) return;
    const dismiss = () => {
      clearHoverTimer();
      setShowPreview(false);
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [showPreview, clearHoverTimer]);

  return (
    <div
      ref={cardRef}
      className="group relative w-full min-w-0"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        onClick={() => onSelect(variantId)}
        title={`${title} · ${sku}`}
        aria-label={`${title}, SKU ${sku}, ${price.toLocaleString("vi-VN")} đồng, ${sb.text}`}
        className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-border-default bg-surface-panel p-2.5
                   text-center transition-shadow duration-150 hover:shadow-md active:shadow-sm
                   focus-visible:outline-2 focus-visible:outline-action-primary focus-visible:outline-offset-2 sm:p-3"
      >
        {/* Thumbnail area */}
        <div className="flex h-16 w-full items-center justify-center overflow-hidden rounded-md bg-surface-subtle sm:h-20">
          {hasImage ? (
            <img
              src={imageUrl}
              alt={title}
              className="h-full w-full object-cover"
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setImgError(true)}
            />
          ) : imgError && imageUrl ? (
            <div className="flex flex-col items-center gap-0.5 text-text-muted" role="status">
              <ImageOff size={18} />
              <span className="text-[9px] leading-none opacity-60">Ảnh lỗi</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-0.5 text-text-muted">
              <Package size={22} />
              <span className="text-[9px] leading-none opacity-60">Chưa có ảnh</span>
            </div>
          )}
        </div>

        {/* Product name */}
        <p className="flex min-h-10 items-center justify-center text-xs font-semibold leading-4 text-text-primary line-clamp-2 sm:min-h-[3rem] sm:line-clamp-3">
          {title}
        </p>

        {/* Price */}
        <p className="whitespace-nowrap text-base font-bold text-action-primary tabular-nums sm:text-lg">
          {price.toLocaleString("vi-VN")} ₫
        </p>

        {/* Stock badge */}
        <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${sb.cls}`}>
          {sb.text}
        </span>

        {/* SKU */}
        <p className="max-w-full truncate text-[10px] text-text-muted" title={sku}>{sku}</p>
      </button>

      {/* Hover image preview — portal to body */}
      {showPreview && hasImage && previewRect && (
        <ImagePreviewPortal imageUrl={imageUrl!} title={title} anchorRect={previewRect} />
      )}

      {/* Full-name info button */}
      <button
        type="button"
        onClick={() => setShowDetails((open) => !open)}
        title="Xem tên sản phẩm đầy đủ"
        aria-label={`Xem tên đầy đủ của ${title}`}
        aria-expanded={showDetails}
        className="absolute right-1.5 top-1.5 inline-flex size-6 items-center justify-center rounded border border-border-subtle bg-surface-panel/95 text-text-muted opacity-100 shadow-sm transition-opacity hover:text-action-primary focus-visible:outline-2 focus-visible:outline-action-primary sm:size-5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
      >
        <Info size={12} />
      </button>

      {/* Full-name popover */}
      {showDetails && (
        <div
          className="absolute inset-x-0 top-full z-[var(--z-popover)] mt-1 rounded-md border border-border-default bg-surface-panel p-2 text-left text-xs shadow-lg"
          role="dialog"
          aria-label="Chi tiết sản phẩm"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="break-words font-semibold leading-5 text-text-primary">{title}</p>
            <button
              type="button"
              onClick={() => setShowDetails(false)}
              title="Đóng"
              aria-label="Đóng chi tiết sản phẩm"
              className="shrink-0 text-text-muted hover:text-text-primary"
            >
              <X size={13} />
            </button>
          </div>
          <p className="mt-1 break-all font-mono text-[10px] text-text-muted">{sku}</p>
        </div>
      )}
    </div>
  );
}
