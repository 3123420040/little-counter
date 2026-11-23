import { randomUUID } from "node:crypto";

export class PlatformError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

const PUBLIC_DETAIL_KEYS: Record<string, string[]> = {
  rate_limited: ["retryAfterSeconds"],
  resend_cooldown: ["retryAfterSeconds"],
  password_policy_violation: ["minLength", "maxLength", "rule"],
  feature_not_entitled: ["feature", "packageKey", "requiredPackage"],
  provider_disabled: ["provider", "reason"],
  staff_limit_exceeded: ["staffLimit"],
  insufficient_stock: ["shortages"],
  stock_shortage_requires_confirmation: ["shortages"],
  shift_not_stale: ["staleAfterMinutes"],
  payload_too_large: ["maxImageBytes"],
  billing_apply_retryable: ["retryAfterSeconds", "attempt"],
  payment_intent_provisioning: ["retryAfterSeconds"],
  payment_settlement_required: ["requiredAmount", "direction"],
  order_correction_conflict: ["currentRevision"],
  invalid_cursor: ["refreshFromStart"],
  stale_cursor: ["refreshFromStart"],
  async_export_required: ["selectedOrderCount", "maximumOrderCount"],
  dashboard_store_time_unavailable: ["issues"],
  validation_error: ["field", "allowed", "maxDays"],
};

function publicDetails(err: PlatformError): Record<string, unknown> | undefined {
  const keys = PUBLIC_DETAIL_KEYS[err.code];
  if (!keys || !err.details) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in err.details) result[key] = err.details[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export interface SerializedPlatformError {
  statusCode: number;
  body: {
    error: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
      correlationId?: string;
    };
  };
  retryAfterSeconds?: number;
}

export function serializePlatformError(err: unknown): SerializedPlatformError {
  if (err instanceof PlatformError) {
    const serverFailure = err.statusCode >= 500;
    const correlationId = serverFailure ? randomUUID() : undefined;
    if (serverFailure) {
      console.error(JSON.stringify({
        level: "error",
        event: "platform_request_failed",
        correlationId,
        errorCode: err.code,
        errorType: err.name,
      }));
    }
    const details = publicDetails(err);
    const retryAfterSeconds = Number(details?.retryAfterSeconds || 0) || undefined;
    return {
      statusCode: err.statusCode,
      body: {
        error: {
          code: err.code,
          message: serverFailure ? "Request could not be completed" : err.message,
          ...(details ? { details } : {}),
          ...(correlationId ? { correlationId } : {}),
        },
      },
      retryAfterSeconds,
    };
  }

  const correlationId = randomUUID();
  const errorType = err instanceof Error ? err.name : typeof err;
  console.error(JSON.stringify({
    level: "error",
    event: "unhandled_request_error",
    correlationId,
    errorCode: "internal_error",
    errorType,
  }));
  return {
    statusCode: 500,
    body: {
      error: {
        code: "internal_error",
        message: "Request could not be completed",
        correlationId,
      },
    },
  };
}

export function sendPlatformError(
  res: {
    status: (code: number) => { json: (body: unknown) => void };
    setHeader?: (name: string, value: string) => void;
  },
  err: unknown,
): void {
  const serialized = serializePlatformError(err);
  if (serialized.retryAfterSeconds && res.setHeader) {
    res.setHeader("Retry-After", String(serialized.retryAfterSeconds));
  }
  res.status(serialized.statusCode).json(serialized.body);
}
