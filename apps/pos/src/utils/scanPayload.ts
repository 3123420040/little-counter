export function scanGoCartTokenFromPayload(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (/^sgt_[a-f0-9]+$/i.test(raw)) return raw;

  try {
    const url = new URL(raw);
    const token = (url.searchParams.get("t") || url.searchParams.get("token") || "").trim();
    return /^sgt_[a-f0-9]+$/i.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function isScanGoCartPayload(value: string): boolean {
  return scanGoCartTokenFromPayload(value) !== null;
}
