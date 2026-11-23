// ═══════════════════════════════════════════════════════
// Structured JSON Logger

// ═══════════════════════════════════════════════════════

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  correlationId?: string;
  durationMs?: number;
  error?: { name: string; code?: string; statusCode?: number };
  [key: string]: unknown;
}

const SENSITIVE_KEY = /(password|passwd|token|secret|authorization|cookie|api[_-]?key|private[_-]?key|credential|jwt|credit[_-]?card|ssn|passport|signature)/i;

function safeErrorMetadata(err: Error): { name: string; code?: string; statusCode?: number } {
  const candidate = err as Error & { code?: unknown; status?: unknown; statusCode?: unknown };
  const name = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(err.name) ? err.name : "Error";
  const code = typeof candidate.code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(candidate.code)
    ? candidate.code
    : undefined;
  const rawStatus = candidate.statusCode ?? candidate.status;
  const statusCode = Number.isInteger(rawStatus) && Number(rawStatus) >= 100 && Number(rawStatus) <= 599
    ? Number(rawStatus)
    : undefined;
  return { name, ...(code ? { code } : {}), ...(statusCode ? { statusCode } : {}) };
}

function sanitizeLogString(value: string): string {
  return value
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/g, "$1[REDACTED]@")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot[REDACTED]")
    .replace(/([?&](?:token|secret|signature|api[_-]?key|authorization|password|credential)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|authorization|password|credential)\s*[=:]\s*([^\s,;&]+)/gi, "$1=[REDACTED]");
}

function sanitizeLogValue(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return sanitizeLogString(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const result = value.map((item) => sanitizeLogValue(item, seen, depth + 1));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object" && value !== null) {
    return redact(value as Record<string, unknown>, seen, depth + 1);
  }
  return value;
}

function redact(obj: Record<string, unknown>, seen = new WeakSet<object>(), depth = 0): Record<string, unknown> {
  if (seen.has(obj)) return { value: "[CIRCULAR]" };
  seen.add(obj);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = sanitizeLogValue(value, seen, depth + 1);
    }
  }
  seen.delete(obj);
  return result;
}

export function createLogger(service: string) {
  function log(level: LogLevel, message: string, context?: Record<string, unknown>) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service,
      message: sanitizeLogString(message),
    };

    if (context) {
      const safe = redact(context);
      Object.assign(entry, safe);
    }

    let output: string;
    try {
      output = JSON.stringify(entry);
    } catch {
      output = JSON.stringify({
        timestamp: entry.timestamp,
        level: entry.level,
        service: entry.service,
        message: "Log serialization failed",
      });
    }

    switch (level) {
      case "error": console.error(output); break;
      case "warn": console.warn(output); break;
      case "debug": if (process.env.NODE_ENV !== "production") console.debug(output); break;
      default: console.log(output);
    }
  }

  return {
    debug: (msg: string, ctx?: Record<string, unknown>) => log("debug", msg, ctx),
    info: (msg: string, ctx?: Record<string, unknown>) => log("info", msg, ctx),
    warn: (msg: string, ctx?: Record<string, unknown>) => log("warn", msg, ctx),
    error: (msg: string, err?: Error, ctx?: Record<string, unknown>) => {
      log("error", msg, {
        ...ctx,
        error: err ? safeErrorMetadata(err) : undefined,
      });
    },
  };
}

export const logger = createLogger("medusa-snus");
