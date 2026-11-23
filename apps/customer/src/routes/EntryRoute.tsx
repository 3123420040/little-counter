import { useNavigate, useParams } from "react-router-dom";
import { ScanLine } from "lucide-react";
import { useScanGoFeature } from "../scan-go/featureGate";
import { MOCK_PRODUCTS } from "../scan-go/mockData";
import { productPath, scanGoLive } from "../scan-go/config";
import { FormatTag } from "../components/FormatTag";
import { FeatureUnavailable } from "./FeatureUnavailable";

/**
 * `/s/:merchantSlug/:storeSlug` entry. Real customers arrive on a product
 * URL directly or visit the store entry to see scanning instructions.
 */
export function EntryRoute() {
  const { merchantSlug = "", storeSlug = "" } = useParams();
  const navigate = useNavigate();
  const { enabled } = useScanGoFeature();
  if (!enabled) return <FeatureUnavailable />;

  const demos = Object.values(MOCK_PRODUCTS).filter((p) => p.availability === "available");

  return (
    <div className="sd-stage sd-no-bounce">
      <div className="sd-pad sd-topbar">
        <span className="text-[13px] font-extrabold uppercase tracking-[0.18em] text-ink">
          Stash <span className="text-dash-deep">Dash</span>
        </span>
      </div>

      <div className="sd-rise flex flex-1 flex-col justify-center gap-6 px-7 py-10">
        <div>
          <div className="inline-flex items-center gap-2 rounded-pill bg-dash-tint px-3 py-1 text-[12px] font-bold uppercase tracking-wide text-dash-deep">
            <ScanLine className="h-4 w-4" strokeWidth={2.5} /> Scan & Go
          </div>
          <h1 className="mt-3 text-[2.4rem] font-extrabold leading-[0.95] tracking-tight text-ink">
            Scan a tag,
            <br />
            build your stash.
          </h1>
          <p className="mt-3 max-w-[32ch] text-[15px] leading-relaxed text-ink-muted">
            Point your phone camera at a shelf tag to open the product. Add what you like, then show
            one QR to staff at the counter.
          </p>
        </div>

        {!scanGoLive() && (
          <div>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-ink-muted">
              Try a demo tag
            </div>
            <div className="grid gap-2">
              {demos.map((p) => (
                <button
                  key={p.qrSlug}
                  type="button"
                  onClick={() => navigate(productPath(merchantSlug, storeSlug, p.qrSlug))}
                  className="flex items-center justify-between gap-3 rounded-md bg-card px-4 py-3 text-left ring-1 ring-inset ring-hairline active:scale-[0.99] transition-transform"
                >
                  <div className="min-w-0">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-ink-muted">
                      {p.brand}
                    </div>
                    <div className="truncate text-[15px] font-bold text-ink">{p.name}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <span className="text-[12px] font-semibold text-ink-soft">{p.strengthLabel}</span>
                      {p.formatTags.slice(0, 2).map((t) => (
                        <FormatTag key={t} label={t} />
                      ))}
                    </div>
                  </div>
                  <span className="tnum shrink-0 text-[15px] font-extrabold text-dash-deep">
                    {new Intl.NumberFormat("en-US").format(p.priceVnd)}₫
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
