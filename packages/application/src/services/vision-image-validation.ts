import { PlatformError } from "../errors/platform-error";

export type VisionImageMime = "image/jpeg" | "image/png" | "image/webp";

export interface NormalizedVisionImage {
  contentBase64: string;
  buffer: Buffer;
  mimeType: VisionImageMime;
}

const MIME_ALIASES: Record<string, VisionImageMime> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
};

function detectImageMime(buffer: Buffer): VisionImageMime | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function decodeStrictBase64(value: string): Buffer {
  const normalized = value.replace(/\s/g, "");
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new PlatformError("validation_error", "imageBase64 is invalid", 400);
  }
  const buffer = Buffer.from(normalized, "base64");
  const canonicalInput = normalized.replace(/=+$/, "");
  const canonicalDecoded = buffer.toString("base64").replace(/=+$/, "");
  if (!buffer.length || canonicalInput !== canonicalDecoded) {
    throw new PlatformError("validation_error", "imageBase64 is invalid", 400);
  }
  return buffer;
}

export function normalizeVisionImageBase64(
  value: unknown,
  options: { maxBytes: number },
): NormalizedVisionImage {
  const raw = String(value || "").trim();
  if (!raw) throw new PlatformError("validation_error", "imageBase64 is required", 400);

  const dataUrlMatch = raw.match(/^data:([^;,]+);base64,(.+)$/is);
  const declaredMime = dataUrlMatch ? MIME_ALIASES[String(dataUrlMatch[1] || "").toLowerCase()] : null;
  if (dataUrlMatch && !declaredMime) {
    throw new PlatformError("validation_error", "imageBase64 must be JPEG, PNG, or WebP", 400);
  }

  const contentBase64 = dataUrlMatch ? dataUrlMatch[2] : raw;
  const buffer = decodeStrictBase64(contentBase64);
  if (buffer.length > options.maxBytes) {
    throw new PlatformError("payload_too_large", "Vision scan image is too large", 413, { maxImageBytes: options.maxBytes });
  }

  const detectedMime = detectImageMime(buffer);
  if (!detectedMime) {
    throw new PlatformError("validation_error", "imageBase64 must be JPEG, PNG, or WebP", 400);
  }
  if (declaredMime && declaredMime !== detectedMime) {
    throw new PlatformError("validation_error", "imageBase64 MIME type does not match image content", 400, {
      declaredMime,
      detectedMime,
    });
  }

  return {
    contentBase64: buffer.toString("base64"),
    buffer,
    mimeType: detectedMime,
  };
}
