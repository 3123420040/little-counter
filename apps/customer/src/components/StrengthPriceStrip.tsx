import { formatVnd } from "../scan-go/formatVnd";

function splitStrength(strengthLabel: string): { num: string; unit: string } {
  const match = strengthLabel.match(/^\s*([\d.,]+)\s*(.*)$/);
  if (!match) return { num: strengthLabel, unit: "" };
  return { num: match[1], unit: match[2].trim() };
}

/** Oversized strength + price moment. The dominant, instantly scannable band. */
export function StrengthPriceStrip({
  strengthLabel,
  priceVnd,
}: {
  strengthLabel: string;
  priceVnd: number;
}) {
  const { num, unit } = splitStrength(strengthLabel);
  return (
    <div className="grid grid-cols-[1.05fr_1fr] items-stretch overflow-hidden rounded-lg ring-1 ring-hairline">
      <div className="flex flex-col justify-center bg-card p-4">
        <div className="text-[11px] font-extrabold uppercase tracking-[0.2em] text-ink-muted">
          Strength
        </div>
        <div className="mt-1.5 flex items-end gap-1.5">
          <span className="text-strength-xl font-extrabold leading-none tracking-tight text-ink tnum">
            {num}
          </span>
          {unit ? (
            <span className="mb-1.5 text-[13px] font-semibold text-ink-muted">{unit}</span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col justify-center bg-dash-ink p-4 text-white">
        <div className="text-[11px] font-extrabold uppercase tracking-[0.2em] text-white/85">
          Price
        </div>
        <div className="mt-1.5 text-price-xl font-extrabold leading-none tracking-tight tnum">
          {formatVnd(priceVnd)}
        </div>
        <div className="mt-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/80">
          VND, in store
        </div>
      </div>
    </div>
  );
}
