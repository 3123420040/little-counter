import { PlatformError } from "../errors/platform-error";

/**
 * Canonical product image URL validation shared by catalog mutations and the
 * later CSV import path. Blank removes the image; non-blank values must be
 * credential-free HTTPS URLs.
 */
export function normalizeProductImageUrl(value: unknown): string | null {
  const url = String(value || "").trim();
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PlatformError("validation_error", "imageUrl must be a valid URL", 400);
  }

  if (parsed.protocol !== "https:") {
    throw new PlatformError("validation_error", "imageUrl must use HTTPS", 400);
  }
  if (parsed.username || parsed.password) {
    throw new PlatformError("validation_error", "imageUrl must not include credentials", 400);
  }

  return parsed.href;
}
