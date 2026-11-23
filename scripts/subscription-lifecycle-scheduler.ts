#!/usr/bin/env tsx
import { runSubscriptionLifecycleScheduler } from "../packages/application/src/services/subscription-service";
import { runSubscriptionLifecycleNotificationPipeline } from "../packages/application/src/services/subscription-lifecycle-notification-service";
import { resolveTransactionalEmailProvider } from "../packages/application/src/email/factory";
import { getPlatformDatabaseUrl } from "../packages/application/src/db/config";
import { ensurePlatformSchema } from "../packages/application/src/db/schema";

function parseArgs(): { dryRun: boolean; now?: Date } {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const nowArg = args.find((a) => a.startsWith("--now="));
  const now = nowArg ? new Date(nowArg.split("=")[1]) : undefined;
  if (now && !Number.isFinite(now.getTime())) {
    console.error("Invalid --now value; must be an ISO timestamp");
    process.exit(1);
  }
  return { dryRun, now };
}

async function main() {
  const { dryRun, now } = parseArgs();
  const clockNow = now || new Date();

  const dbUrl = getPlatformDatabaseUrl();
  if (!dbUrl) {
    console.error("DATABASE_URL / PLATFORM_DATABASE_URL is not set");
    process.exit(1);
  }

  if (dryRun) {
    console.log("[subscription-scheduler] --dry-run: would evaluate subscriptions at", clockNow.toISOString());
    process.exit(0);
  }

  await ensurePlatformSchema();

  const result = await runSubscriptionLifecycleScheduler({ now: clockNow });
  const { emitted, reminders, enteredGrace, graceEnding, expired } = result.data;
  const notifications = await runSubscriptionLifecycleNotificationPipeline(resolveTransactionalEmailProvider(), { now: clockNow });
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    schedulerRun: "subscription_lifecycle",
    clockNow: clockNow.toISOString(),
    emitted,
    reminders,
    enteredGrace,
    graceEnding,
    expired,
    notifications,
  }));

  process.exit(0);
}

main().catch((err) => {
  console.error("[subscription-scheduler] Fatal error:", err);
  process.exit(1);
});
