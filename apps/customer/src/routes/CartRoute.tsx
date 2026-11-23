import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ScanLine, Trash2, ArrowRight, ShoppingBag } from "lucide-react";
import { useScanGoCart } from "../scan-go/useScanGoCart";
import { useAgeGate } from "../scan-go/useAgeGate";
import { useScanGoFeature } from "../scan-go/featureGate";
import { formatVnd } from "../scan-go/formatVnd";
import { cartPath, productPath, readyPath } from "../scan-go/config";
import { AgeGate } from "../components/AgeGate";
import { QuantityStepper } from "../components/QuantityStepper";
import { ContactFields } from "../components/ContactFields";
import { MiniTin } from "../components/ProductVisual";
import { ScreenState } from "../components/ScreenState";
import { ScanAnother } from "../components/ScanAnother";
import { FeatureUnavailable } from "./FeatureUnavailable";

export function CartRoute() {
  const { merchantSlug = "", storeSlug = "" } = useParams();
  const navigate = useNavigate();
  const { enabled } = useScanGoFeature();
  const cart = useScanGoCart(merchantSlug, storeSlug);
  const age = useAgeGate(merchantSlug, storeSlug);
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!enabled) return <FeatureUnavailable />;
  if (!age.acknowledged) return <AgeGate onAcknowledge={age.acknowledge} />;

  const goReady = () => navigate(readyPath(merchantSlug, storeSlug));
  const pickSlug = (slug: string) => {
    setSheetOpen(false);
    navigate(productPath(merchantSlug, storeSlug, slug));
  };

  if (cart.lines.length === 0) {
    return (
      <div className="sd-stage sd-no-bounce">
        <div className="sd-pad sd-topbar flex items-center justify-between">
          <span className="text-[13px] font-extrabold uppercase tracking-[0.18em] text-ink">
            Stash <span className="text-dash-deep">Dash</span>
          </span>
        </div>
        <ScreenState
          icon={<ShoppingBag className="h-7 w-7" strokeWidth={2.5} />}
          title="Your stash is empty"
          body="Scan a shelf tag to start building it."
          action={
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className="inline-flex items-center gap-2 rounded-pill bg-ink px-5 py-3 text-sm font-bold text-paper"
            >
              <ScanLine className="h-4 w-4" strokeWidth={2.5} /> Scan a tag
            </button>
          }
        />
        <ScanAnother
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          onViewStash={() => navigate(cartPath(merchantSlug, storeSlug))}
          onPickSlug={pickSlug}
        />
      </div>
    );
  }

  return (
    <div className="sd-stage sd-no-bounce">
      <div className="sd-pad sd-topbar flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-label="Scan another tag"
          className="grid h-10 w-10 place-items-center rounded-full bg-card text-ink shadow-sm ring-1 ring-hairline active:scale-95 transition-transform"
        >
          <ScanLine className="h-5 w-5" strokeWidth={2.5} />
        </button>
        <h1 className="text-[17px] font-extrabold tracking-tight text-ink">
          Your stash{" "}
          <span className="tnum align-middle text-ink-muted">({cart.totalQuantity})</span>
        </h1>
        <span className="w-10" />
      </div>

      <div className="sd-rise flex flex-1 flex-col gap-4 pb-4">
        <div className="sd-pad">
          <ul className="divide-y divide-hairline overflow-hidden rounded-md bg-card ring-1 ring-hairline">
            {cart.lines.map((line) => (
              <li key={line.variantId} className="flex gap-3 p-3">
                <MiniTin brand={line.brand} strengthLabel={line.strengthLabel} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[11px] font-bold uppercase tracking-wide text-ink-muted">
                        {line.brand}
                      </div>
                      <div className="truncate text-[15px] font-bold text-ink">{line.title}</div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">{line.sku}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => cart.removeLine(line.variantId)}
                      aria-label={`Remove ${line.title}`}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-paper-band text-ink-muted transition-colors hover:text-ember"
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={2.5} />
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <QuantityStepper
                      ariaLabel={line.title}
                      value={line.quantity}
                      onIncrement={() => cart.increment(line.variantId)}
                      onDecrement={() => cart.decrement(line.variantId)}
                    />
                    <div className="tnum text-right text-[15px] font-extrabold text-ink">
                      {formatVnd(line.unitPriceVnd * line.quantity)}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="sd-pad">
          <ContactFields
            nickname={cart.customerNickname}
            contact={cart.customerContact}
            contactType={cart.contactType}
            onNickname={cart.setNickname}
            onContact={cart.setContact}
            onContactType={cart.setContactType}
          />
        </div>

        <div className="sd-pad">
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Clear everything in your stash?")) cart.clear();
            }}
            className="text-[13px] font-semibold text-ink-muted underline-offset-2 hover:text-ember hover:underline"
          >
            Clear stash
          </button>
        </div>
      </div>

      <div className="sd-cta-bar">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wide text-ink-muted">Total</div>
            <div className="text-[12px] text-ink-muted">{cart.totalQuantity} items, VND</div>
          </div>
          <div className="tnum text-[26px] font-extrabold tracking-tight text-ink">
            {formatVnd(cart.totalVnd)}
          </div>
        </div>
        <button
          type="button"
          onClick={goReady}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-pill bg-dash-ink text-[17px] font-bold text-white shadow-pop active:scale-[0.98] transition-transform"
        >
          I'm Ready
          <ArrowRight className="h-5 w-5" strokeWidth={2.5} />
        </button>
      </div>

      <ScanAnother
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onViewStash={() => setSheetOpen(false)}
        onPickSlug={pickSlug}
      />
    </div>
  );
}
