import { useState } from "react";
import { ShieldCheck, ArrowLeft } from "lucide-react";

/**
 * Mobile-first full-screen 18+ interstitial. Product content stays hidden
 * until acknowledgement. Stores no ID; this is an acknowledgement, not
 * proof of age. Staff verify at the counter.
 */
export function AgeGate({ onAcknowledge }: { onAcknowledge: () => void }) {
  const [leaving, setLeaving] = useState(false);

  if (leaving) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-ink px-8 text-center text-paper">
        <p className="text-lg font-bold">No worries.</p>
        <p className="max-w-[30ch] text-sm text-paper/70">
          You can close this tab. Come back when you're ready.
        </p>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink px-6 py-10"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 2.5rem)" }}
    >
      <div className="sd-pop w-full max-w-[380px]">
        <div className="rounded-lg bg-card p-7 shadow-lift">
          <div className="flex items-center gap-2 text-dash">
            <ShieldCheck className="h-5 w-5" strokeWidth={2.5} />
            <span className="text-[13px] font-extrabold uppercase tracking-[0.22em]">18+ only</span>
          </div>

          <h1 className="mt-3 text-[2.6rem] font-extrabold leading-[0.95] tracking-tight text-ink">
            Adults only
          </h1>

          <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">
            This shop experience is for customers 18+. Staff will verify age before checkout.
          </p>

          <div className="mt-7 space-y-2.5">
            <button
              type="button"
              onClick={onAcknowledge}
              className="flex h-14 w-full items-center justify-center rounded-pill bg-dash-ink text-[17px] font-bold text-white shadow-pop active:scale-[0.98] transition-transform"
            >
              I am 18+
            </button>
            <button
              type="button"
              onClick={() => setLeaving(true)}
              className="flex h-12 w-full items-center justify-center gap-1.5 rounded-pill text-[15px] font-semibold text-ink-muted transition-colors hover:text-ink"
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={2.5} />
              Leave
            </button>
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-paper/55">
          No ID upload. Just a quick check at the counter.
        </p>
      </div>
    </div>
  );
}
