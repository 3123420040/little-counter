/** Best-effort haptic feedback. Fails silently when unsupported. */
export function hapticTap(pattern: number | number[] = 14): void {
  try {
    const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
    if (typeof nav.vibrate === "function") {
      nav.vibrate(pattern);
    }
  } catch {
    /* no-op */
  }
}
