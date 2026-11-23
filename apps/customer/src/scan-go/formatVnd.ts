/* VND only. MVP never renders USD approximation anywhere. */

const grouping = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 250000 -> "250,000₫" */
export function formatVnd(amountVnd: number): string {
  return `${grouping.format(Math.round(amountVnd))}₫`;
}

/** Compact total for tight chips: 1250000 -> "1,250,000₫" (no k rounding to keep price honest). */
export function formatVndCompact(amountVnd: number): string {
  return formatVnd(amountVnd);
}
