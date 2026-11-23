import { useState } from "react";

function parseStrengthNumber(strengthLabel: string): string {
  const match = strengthLabel.match(/^\s*([\d.,]+)/);
  return match ? match[1] : strengthLabel;
}

/** Always-present typographic tin face (stable 4:5 size, never text-only). */
function TinFace({
  brand,
  flavor,
  strengthLabel,
}: {
  brand: string;
  flavor: string;
  strengthLabel: string;
}) {
  return (
    <div className="relative z-[2] flex h-full flex-col justify-between p-5 text-paper">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-extrabold uppercase tracking-[0.24em] text-paper/85">
          {brand}
        </span>
        <span className="rounded-pill bg-paper/15 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-paper/80">
          Nicotine pouch
        </span>
      </div>
      <div>
        <div className="text-[15px] font-semibold uppercase tracking-wide text-paper/75">
          {flavor}
        </div>
        <div className="mt-1 flex items-end gap-2 leading-none">
          <span className="text-[clamp(3rem,16vw,4.75rem)] font-extrabold tracking-tight tnum text-paper">
            {parseStrengthNumber(strengthLabel)}
          </span>
          <span className="mb-2 text-xs font-semibold uppercase tracking-wide text-paper/70">
            mg/pouch
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Product visual. Shows the approved image when available; otherwise a
 * premium typographic tin with stable dimensions (no text-only flow, no
 * hand-rolled decorative SVG as the main asset).
 */
export function ProductVisual({
  brand,
  name,
  flavor,
  strengthLabel,
  imageUrl,
}: {
  brand: string;
  name: string;
  flavor: string;
  strengthLabel: string;
  imageUrl: string | null;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !imageFailed;

  return (
    <div className="sd-tin">
      {showImage && imageUrl ? (
        <img
          src={imageUrl}
          alt={`${brand} ${name}`}
          loading="eager"
          decoding="async"
          onError={() => setImageFailed(true)}
          className="absolute inset-0 z-[2] h-full w-full object-cover"
        />
      ) : (
        <TinFace brand={brand} flavor={flavor} strengthLabel={strengthLabel} />
      )}
    </div>
  );
}

/** Compact tin for cart rows. Typographic, stable size, no nested card. */
export function MiniTin({ brand, strengthLabel }: { brand: string; strengthLabel: string }) {
  const num = parseStrengthNumber(strengthLabel);
  return (
    <div
      className="relative grid h-[72px] w-[58px] shrink-0 place-items-center overflow-hidden rounded-md text-paper"
      style={{ background: "linear-gradient(135deg, rgb(var(--dash-rgb)) 0 42%, rgb(var(--ink-rgb)) 42.2% 100%)" }}
      aria-hidden="true"
    >
      <div className="relative z-[2] flex flex-col items-center">
        <span className="text-[9px] font-extrabold uppercase tracking-wide text-paper/85">{brand}</span>
        <span className="tnum text-lg font-extrabold leading-none">{num}</span>
      </div>
    </div>
  );
}
