import { useMemo } from "react";
import { RefreshCw, ArrowLeft, WifiOff, Clock, ShieldAlert } from "lucide-react";
import type { CheckoutTokenDto } from "../scan-go/types";
import { formatVnd } from "../scan-go/formatVnd";
import { buildQrSvg } from "../scan-go/qrSvg";
import { Countdown } from "./Countdown";

function chunkCode(token: string): string {
  return token.replace(/-/g, "").replace(/(.{4})/g, "$1 ").trim();
}

export function FinalQrCard({
  status,
  token,
  secondsLeft,
  nickname,
  itemCount,
  totalVnd,
  offline,
  onRegenerate,
  onEdit,
}: {
  status: "generating" | "ready" | "expired" | "error";
  token: CheckoutTokenDto | null;
  secondsLeft: number;
  nickname?: string | null;
  itemCount: number;
  totalVnd: number;
  offline?: boolean;
  onRegenerate: () => void;
  onEdit: () => void;
}) {
  const urgent = status === "ready" && secondsLeft <= 300;
  const qrSvg = useMemo(
    () => (token ? buildQrSvg(token.qrPayload) : ""),
    [token?.qrPayload],
  );

  return (
    <div className="flex flex-1 flex-col">
      {/* Header: instruction, edit kept subtle */}
      <div className="sd-pad sd-topbar flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">Show this to staff</h1>
          <p className="text-[13px] text-ink-muted">Hold your screen up at the counter.</p>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1 rounded-pill px-3 py-2 text-[13px] font-semibold text-ink-soft transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2.5} />
          Edit stash
        </button>
      </div>

      <div className="sd-pad flex flex-1 flex-col items-center justify-center gap-5 pb-10">
        {status === "generating" ? (
          <div className="sd-rise flex flex-col items-center gap-4 text-center">
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-paper-deep border-t-dash" />
            <p className="text-[15px] font-semibold text-ink-muted">Making your QR…</p>
          </div>
        ) : null}

        {status === "ready" && token ? (
          <>
            <div
              className="sd-assemble qr-tile w-full max-w-[300px]"
              data-testid="qr-tile"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />

            <div className="w-full max-w-[300px] sd-rise">
              {nickname ? (
                <p className="text-center text-[15px] font-bold text-ink">{nickname}</p>
              ) : null}

              <div className="mt-1 flex items-center justify-center gap-2 text-ink">
                <span className="tnum text-lg font-extrabold">{itemCount}</span>
                <span className="text-sm text-ink-muted">items</span>
                <span className="text-ink-muted">·</span>
                <span className="tnum text-lg font-extrabold text-dash-deep">{formatVnd(totalVnd)}</span>
              </div>

              <div
                className={`mt-3 flex items-center justify-center gap-1.5 rounded-pill px-3 py-2 text-sm font-bold ${
                  urgent ? "bg-ember/10 text-ember" : "bg-paper-band text-ink-soft"
                }`}
              >
                <Clock className="h-4 w-4" strokeWidth={2.5} />
                <span>Expires in </span>
                <Countdown seconds={secondsLeft} className="text-base" />
              </div>

              <p className="mt-3 text-center text-[12px] leading-relaxed text-ink-muted">
                ID may be checked before payment.
              </p>
            </div>
          </>
        ) : null}

        {status === "expired" ? (
          <div className="sd-rise flex w-full max-w-[320px] flex-col items-center gap-4 rounded-lg bg-card p-7 text-center shadow-lift">
            <div className="grid h-14 w-14 place-items-center rounded-full bg-dash-tint text-dash-deep">
              <ShieldAlert className="h-7 w-7" strokeWidth={2.5} />
            </div>
            <div>
              <h2 className="text-xl font-extrabold text-ink">This QR expired</h2>
              <p className="mt-1 text-sm text-ink-muted">Your stash is safe. Make a fresh QR for staff.</p>
            </div>
            <button
              type="button"
              onClick={onRegenerate}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-pill bg-dash-ink px-5 py-3.5 text-[16px] font-bold text-white shadow-pop active:scale-[0.98] transition-transform"
            >
              <RefreshCw className="h-5 w-5" strokeWidth={2.5} />
              Make a fresh QR
            </button>
          </div>
        ) : null}

        {status === "error" ? (
          <div className="sd-rise flex w-full max-w-[320px] flex-col items-center gap-4 rounded-lg bg-card p-7 text-center shadow-lift">
            <div className="grid h-14 w-14 place-items-center rounded-full bg-dash-tint text-dash-deep">
              {offline ? <WifiOff className="h-7 w-7" strokeWidth={2.5} /> : <RefreshCw className="h-7 w-7" strokeWidth={2.5} />}
            </div>
            <div>
              <h2 className="text-xl font-extrabold text-ink">
                {offline ? "You're offline" : "Couldn't make the QR"}
              </h2>
              <p className="mt-1 text-sm text-ink-muted">
                {offline ? "Reconnect and try again." : "Give it another go and we'll rebuild it."}
              </p>
            </div>
            <button
              type="button"
              onClick={onRegenerate}
              className="flex w-full items-center justify-center gap-2 rounded-pill bg-dash-ink px-5 py-3.5 text-[16px] font-bold text-white shadow-pop active:scale-[0.98] transition-transform"
            >
              <RefreshCw className="h-5 w-5" strokeWidth={2.5} />
              Try again
            </button>
          </div>
        ) : null}

        {/* Human-readable fallback code (scan backup) */}
        {status === "ready" && token ? (
          <div className="w-full max-w-[300px] text-center">
            <div className="text-[11px] font-bold uppercase tracking-wide text-ink-muted">
              Scan won't read? Read this code to staff
            </div>
            <div className="mt-1 font-mono text-[13px] font-semibold tracking-wide text-ink-soft break-words">
              {chunkCode(token.token)}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
