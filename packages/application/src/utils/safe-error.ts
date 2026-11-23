import { PlatformError } from "../errors/platform-error";

function stableCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : undefined;
}

export function safeErrorCode(error: unknown, fallback = "unexpected_error"): string {
  const candidate = error as { code?: unknown; name?: unknown };
  return stableCode(candidate?.code) || stableCode(candidate?.name) || fallback;
}

export function safeErrorMetadata(error: unknown): { errorType: string; errorCode?: string; statusCode?: number } {
  const candidate = error as { code?: unknown; name?: unknown; status?: unknown; statusCode?: unknown };
  const errorCode = stableCode(candidate?.code);
  const rawStatus = candidate?.statusCode ?? candidate?.status;
  const statusCode = Number.isInteger(rawStatus) && Number(rawStatus) >= 100 && Number(rawStatus) <= 599
    ? Number(rawStatus)
    : undefined;
  return {
    errorType: stableCode(candidate?.name) || typeof error,
    ...(errorCode ? { errorCode } : {}),
    ...(statusCode ? { statusCode } : {}),
  };
}

export function publicOperationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof PlatformError && error.statusCode < 500) return error.message;
  return fallback;
}
