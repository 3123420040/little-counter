import { Minus, Plus } from "lucide-react";

/**
 * Thumb-friendly, stable-size quantity control. Buttons never resize the
 * row (fixed width, equal-height) so tapping +/- repeatedly stays put.
 */
export function QuantityStepper({
  value,
  onIncrement,
  onDecrement,
  ariaLabel = "quantity",
  size = "md",
}: {
  value: number;
  onIncrement: () => void;
  onDecrement: () => void;
  ariaLabel?: string;
  size?: "md" | "lg";
}) {
  const btn =
    size === "lg"
      ? "h-12 w-12 text-xl"
      : "h-11 w-11 text-lg";
  const count = size === "lg" ? "text-2xl" : "text-xl";
  return (
    <div
      className="inline-flex items-center gap-1 rounded-pill bg-paper-deep p-1 ring-1 ring-inset ring-hairline"
      role="group"
      aria-label={ariaLabel}
    >
      <button
        type="button"
        onClick={onDecrement}
        aria-label={`Decrease ${ariaLabel}`}
        className={`grid place-items-center rounded-pill bg-card text-ink shadow-sm active:scale-95 transition-transform ${btn}`}
      >
        <Minus className="h-5 w-5" strokeWidth={2.5} />
      </button>
      <span
        className={`tnum min-w-[2.25rem] text-center font-bold text-ink ${count}`}
        aria-live="polite"
      >
        {value}
      </span>
      <button
        type="button"
        onClick={onIncrement}
        aria-label={`Increase ${ariaLabel}`}
        className={`grid place-items-center rounded-pill bg-ink text-paper shadow-sm active:scale-95 transition-transform ${btn}`}
      >
        <Plus className="h-5 w-5" strokeWidth={2.5} />
      </button>
    </div>
  );
}
