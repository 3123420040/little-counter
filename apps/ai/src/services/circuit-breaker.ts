// ═══════════════════════════════════════════════════════
// Circuit Breaker — Prevents cascading failures

// ═══════════════════════════════════════════════════════

interface CircuitState {
  failures: number;
  lastFailureTime: number;
  state: "closed" | "open" | "half-open";
  openUntil: number;
}

const circuits = new Map<string, CircuitState>();

const DEFAULT_THRESHOLD = 5;
const DEFAULT_RESET_MS = 60_000;
const DEFAULT_HALF_OPEN_TIMEOUT = 30_000;

export function createCircuitBreaker(options?: {
  threshold?: number;
  resetMs?: number;
  name?: string;
}) {
  const name = options?.name || "default";
  const threshold = options?.threshold || DEFAULT_THRESHOLD;
  const resetMs = options?.resetMs || DEFAULT_RESET_MS;

  function getState(): CircuitState {
    if (!circuits.has(name)) {
      circuits.set(name, { failures: 0, lastFailureTime: 0, state: "closed", openUntil: 0 });
    }
    return circuits.get(name)!;
  }

  return {
    async execute<T>(fn: () => Promise<T>): Promise<T> {
      const s = getState();
      const now = Date.now();

      // Check if circuit is open
      if (s.state === "open") {
        if (now < s.openUntil) {
          throw new CircuitBreakerError(`Circuit ${name} is open`);
        }
        // Transition to half-open
        s.state = "half-open";
      }

      try {
        const result = await fn();
        // Success: close circuit
        s.failures = 0;
        s.state = "closed";
        return result;
      } catch (err) {
        s.failures++;
        s.lastFailureTime = now;

        if (s.failures >= threshold) {
          s.state = "open";
          s.openUntil = now + resetMs;
        }
        throw err;
      }
    },

    getStatus() {
      return { ...getState() };
    },
  };
}

export class CircuitBreakerError extends Error {
  constructor(message: string) { super(message); this.name = "CircuitBreakerError"; }
}

// ── Retry with Exponential Backoff ─────────────────────

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelay = options?.baseDelayMs ?? 1000;
  const maxDelay = options?.maxDelayMs ?? 30_000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (err instanceof Error && (err as unknown as Record<string, unknown>).retryable === false) {
        throw err;
      }

      // Don't retry on 4xx errors
      if (err instanceof Error && (err as unknown as Record<string, unknown>).statusCode) {
        const status = (err as unknown as Record<string, unknown>).statusCode as number;
        if (status >= 400 && status < 500) throw err;
      }

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        const jitter = delay * 0.1 * Math.random();
        await new Promise(resolve => setTimeout(resolve, delay + jitter));
      }
    }
  }

  throw lastError;
}
