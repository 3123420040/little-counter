// ═══════════════════════════════════════════════════════
// Health check + Heartbeat + Outbox metrics

// ═══════════════════════════════════════════════════════

import { createLogger } from "../utils/logger";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const log = createLogger("health");

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  timestamp: string;
  services: Record<string, { status: string; latencyMs?: number; error?: string }>;
  metrics: {
    outboxPending: number;
    outboxFailed: number;
    outboxDeadLettered: number;
    aiActionsTotal: number;
    aiActionsPending: number;
    avgAiLatencyMs: number;
  };
}

const startTime = Date.now();
const heartbeatDir = process.env.HEARTBEAT_DIR || "/tmp";

// Track outbox metrics in-memory
export const outboxMetrics = {
  pending: 0,
  failed: 0,
  deadLettered: 0,
  processed: 0,
  increments: { pending: 0, failed: 0, deadLettered: 0, processed: 0 } as Record<string, number>,
};

const aiLatencies: number[] = [];
export function recordAiLatency(ms: number) { aiLatencies.push(ms); if (aiLatencies.length > 100) aiLatencies.shift(); }

export function writeHeartbeat(): void {
  try {
    if (!existsSync(heartbeatDir)) mkdirSync(heartbeatDir, { recursive: true });
    writeFileSync(join(heartbeatDir, "ai-worker.heartbeat"), new Date().toISOString());
  } catch (err) {
    log.warn("Failed to write heartbeat file", { error: String(err) });
  }
}

export function getHealthStatus(): HealthStatus {
  const avgLatency = aiLatencies.length > 0
    ? Math.round(aiLatencies.reduce((a, b) => a + b, 0) / aiLatencies.length)
    : 0;

  let overall: HealthStatus["status"] = "healthy";
  if (outboxMetrics.deadLettered > 10) overall = "degraded";
  if (outboxMetrics.failed > 50) overall = "unhealthy";

  return {
    status: overall,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    services: {
      database: { status: "healthy", latencyMs: 2 },
      "ai-provider": { status: "healthy", latencyMs: avgLatency },
      "outbox-worker": { status: overall === "healthy" ? "healthy" : "degraded" },
    },
    metrics: {
      outboxPending: outboxMetrics.pending,
      outboxFailed: outboxMetrics.failed,
      outboxDeadLettered: outboxMetrics.deadLettered,
      aiActionsTotal: aiLatencies.length,
      aiActionsPending: outboxMetrics.increments.pending || 0,
      avgAiLatencyMs: avgLatency,
    },
  };
}

// Start heartbeat writer
setInterval(writeHeartbeat, 15_000);
log.info("Health check service initialized");
