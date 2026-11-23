const COOL_TOKENS = new Set(["COOLING", "COOL", "FROST", "MINT", "FROZEN"]);

export function FormatTag({ label }: { label: string }) {
  const upper = label.toUpperCase();
  const cool = COOL_TOKENS.has(upper);
  return (
    <span
      className={[
        "inline-flex items-center rounded-pill px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide",
        cool
          ? "bg-frost-tint text-ink"
          : "bg-paper-deep text-ink-soft ring-1 ring-inset ring-hairline",
      ].join(" ")}
    >
      {label}
    </span>
  );
}
