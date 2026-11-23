import { ShoppingBag } from "lucide-react";

/** Persistent stash indicator shown after the first add. Pulses on count change. */
export function StashChip({
  count,
  onClick,
  ariaLabel = "View your stash",
}: {
  count: number;
  onClick: () => void;
  ariaLabel?: string;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${ariaLabel}: ${count} item${count === 1 ? "" : "s"}`}
      className="relative inline-flex items-center gap-1.5 rounded-pill bg-ink px-3.5 py-2 text-sm font-bold text-paper shadow-lift active:scale-95 transition-transform"
    >
      <ShoppingBag className="h-4 w-4" strokeWidth={2.5} />
      <span className="tnum">{count}</span>
      <span
        key={count}
        className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-dash sd-bump"
        aria-hidden="true"
      />
    </button>
  );
}
