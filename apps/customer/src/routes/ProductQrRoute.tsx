import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ScanLine, AlertTriangle, RefreshCw } from "lucide-react";
import { resolveProduct } from "../scan-go/productResolver";
import { ProductResolveError, type ProductPublicDto } from "../scan-go/types";
import { useScanGoCart } from "../scan-go/useScanGoCart";
import { useAgeGate } from "../scan-go/useAgeGate";
import { useScanGoFeature } from "../scan-go/featureGate";
import { hapticTap } from "../scan-go/haptics";
import { formatVnd } from "../scan-go/formatVnd";
import { cartPath, productPath } from "../scan-go/config";
import { AgeGate } from "../components/AgeGate";
import { ProductVisual } from "../components/ProductVisual";
import { StrengthPriceStrip } from "../components/StrengthPriceStrip";
import { FormatTag } from "../components/FormatTag";
import { QuantityStepper } from "../components/QuantityStepper";
import { StashChip } from "../components/StashChip";
import { ScanAnother } from "../components/ScanAnother";
import { ScreenState, ProductSkeleton } from "../components/ScreenState";
import { FeatureUnavailable } from "./FeatureUnavailable";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; code: string }
  | { kind: "unavailable" }
  | { kind: "ready"; product: ProductPublicDto };

export function ProductQrRoute() {
  const { merchantSlug = "", storeSlug = "", qrSlug = "" } = useParams();
  const navigate = useNavigate();
  const { enabled } = useScanGoFeature();
  const cart = useScanGoCart(merchantSlug, storeSlug);
  const age = useAgeGate(merchantSlug, storeSlug);

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [flying, setFlying] = useState(false);
  const flyTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    resolveProduct({ merchantSlug, storeSlug, qrSlug })
      .then((product) => {
        if (cancelled) return;
        setState(
          product.availability === "available"
            ? { kind: "ready", product }
            : { kind: "unavailable" },
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const code = err instanceof ProductResolveError ? err.code : "network_error";
        setState({ kind: "error", code });
      });
    return () => {
      cancelled = true;
    };
  }, [merchantSlug, storeSlug, qrSlug, retryKey]);

  useEffect(() => () => {
    if (flyTimer.current !== null) window.clearTimeout(flyTimer.current);
  }, []);

  if (!enabled) return <FeatureUnavailable />;

  // Age gate first. Product content stays completely hidden until acknowledged.
  if (!age.acknowledged) {
    return <AgeGate onAcknowledge={age.acknowledge} />;
  }

  const goCart = () => navigate(cartPath(merchantSlug, storeSlug));
  const openSheet = () => setSheetOpen(true);
  const pickSlug = (slug: string) => {
    setSheetOpen(false);
    navigate(productPath(merchantSlug, storeSlug, slug));
  };

  let body: ReactNode;
  if (state.kind === "loading") {
    body = <ProductSkeleton />;
  } else if (state.kind === "error") {
    body = (
      <ScreenState
        tone="ember"
        icon={<AlertTriangle className="h-7 w-7" strokeWidth={2.5} />}
        title="Couldn't load this tag"
        body={state.code === "network_error" ? "Check your connection and try again." : "We couldn't match this tag to a product."}
        action={
          <button
            type="button"
            onClick={() => setRetryKey((k) => k + 1)}
            className="inline-flex items-center gap-2 rounded-pill bg-ink px-5 py-3 text-sm font-bold text-paper"
          >
            <RefreshCw className="h-4 w-4" strokeWidth={2.5} /> Try again
          </button>
        }
      />
    );
  } else if (state.kind === "unavailable") {
    body = (
      <ScreenState
        icon={<ScanLine className="h-7 w-7" strokeWidth={2.5} />}
        title="Not on the shelf right now"
        body="This product is off the shelf. Try another tag."
        action={
          <button
            type="button"
            onClick={openSheet}
            className="inline-flex items-center gap-2 rounded-pill bg-ink px-5 py-3 text-sm font-bold text-paper"
          >
            <ScanLine className="h-4 w-4" strokeWidth={2.5} /> Scan another tag
          </button>
        }
      />
    );
  } else {
    const product = state.product;
    const line = cart.lineForVariant(product.variantId);

    const handleAdd = () => {
      cart.addLine(product);
      hapticTap();
      setFlying(true);
      if (flyTimer.current !== null) window.clearTimeout(flyTimer.current);
      flyTimer.current = window.setTimeout(() => setSheetOpen(true), 360);
    };

    body = (
      <>
        <div className="sd-pad sd-topbar flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={openSheet}
            aria-label="Scan another tag"
            className="grid h-10 w-10 place-items-center rounded-full bg-card text-ink shadow-sm ring-1 ring-hairline active:scale-95 transition-transform"
          >
            <ScanLine className="h-5 w-5" strokeWidth={2.5} />
          </button>
          <span className="text-[13px] font-extrabold uppercase tracking-[0.18em] text-ink">
            Stash <span className="text-dash-deep">Dash</span>
          </span>
          <StashChip count={cart.totalQuantity} onClick={goCart} />
        </div>

        <div className="sd-rise flex flex-1 flex-col">
          <div className="sd-pad pt-1">
            <div className="text-[13px] font-bold uppercase tracking-[0.18em] text-ink-muted">
              {product.brand}
            </div>
            <h1 className="mt-0.5 text-[26px] font-extrabold leading-tight tracking-tight text-ink">
              {product.name}
            </h1>
          </div>

          <div className="sd-pad mt-3">
            <ProductVisual
              brand={product.brand}
              name={product.name}
              flavor={product.flavor}
              strengthLabel={product.strengthLabel}
              imageUrl={product.imageUrl}
            />
          </div>

          <div className="sd-pad mt-4">
            <StrengthPriceStrip strengthLabel={product.strengthLabel} priceVnd={product.priceVnd} />
          </div>

          {product.formatTags.length > 0 ? (
            <div className="sd-pad mt-3 flex flex-wrap gap-1.5">
              {product.formatTags.map((tag) => (
                <FormatTag key={tag} label={tag} />
              ))}
            </div>
          ) : null}

          {product.approvedStory ? (
            <p className="sd-pad mt-3 text-[15px] leading-relaxed text-ink-soft">
              {product.approvedStory}
            </p>
          ) : null}
        </div>

        {/* Add-to-stash fly chip (transform/opacity only; hidden under reduced motion) */}
        {flying ? (
          <div
            className="pointer-events-none fixed bottom-24 left-1/2 z-30 -translate-x-1/2 sd-fly"
            style={{ "--fly-x": "120px", "--fly-y": "-60vh" } as CSSProperties}
            onAnimationEnd={() => setFlying(false)}
            aria-hidden="true"
          >
            <span className="inline-flex items-center gap-1 rounded-pill bg-dash-ink px-3 py-1.5 text-sm font-bold text-white shadow-pop">
              +1 {product.brand}
            </span>
          </div>
        ) : null}

        <div className="sd-cta-bar">
          {line ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[12px] font-bold uppercase tracking-wide text-ink-muted">
                  In your stash
                </div>
                <div className="text-[13px] font-semibold text-ink-soft">
                  {formatVnd(product.priceVnd)} each
                </div>
              </div>
              <QuantityStepper
                size="lg"
                ariaLabel={product.name}
                value={line.quantity}
                onIncrement={() => cart.increment(product.variantId)}
                onDecrement={() => cart.decrement(product.variantId)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={handleAdd}
              className="flex h-14 w-full items-center justify-center rounded-pill bg-dash-ink text-[17px] font-bold text-white shadow-pop active:scale-[0.98] transition-transform"
            >
              Add to my Stash
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="sd-stage sd-no-bounce">
      {body}
      <ScanAnother
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onViewStash={goCart}
        onPickSlug={pickSlug}
      />
    </div>
  );
}
