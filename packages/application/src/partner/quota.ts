import Redis from "ioredis";
import { PartnerError } from "./errors";

// Redis TIME is authoritative across replicas. All budget checks happen before
// any bucket mutation; a rejected request cannot drain another partner's bucket.
const takeBuckets = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + tonumber(clock[2]) / 1000
local values = {}
local wait = 0
for i,key in ipairs(KEYS) do
  local rate = tonumber(ARGV[(i-1)*2+1]) / 60000
  local burst = tonumber(ARGV[(i-1)*2+2])
  local bucket = redis.call('HMGET',key,'tokens','at')
  local tokens = math.min(burst,tonumber(bucket[1] or burst) + math.max(0,now-tonumber(bucket[2] or now))*rate)
  values[i] = tokens
  if tokens < 1 then wait = math.max(wait,math.ceil((1-tokens)/rate/1000)) end
end
if wait > 0 then return wait end
for i,key in ipairs(KEYS) do
  redis.call('HSET',key,'tokens',values[i]-1,'at',now)
  redis.call('PEXPIRE',key,math.ceil(tonumber(ARGV[(i-1)*2+2])*60000/tonumber(ARGV[(i-1)*2+1]))+60000)
end
return 0`;
const acquireLease = `
local clock = redis.call('TIME')
local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)
for i,key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE',key,'-inf',now)
  if redis.call('ZCARD',key) >= tonumber(ARGV[i+2]) then return 0 end
end
for _,key in ipairs(KEYS) do
  redis.call('ZADD',key,now+tonumber(ARGV[2]),ARGV[1])
  redis.call('PEXPIRE',key,tonumber(ARGV[2])*2)
end
return 1`;
const releaseLease = `for _,key in ipairs(KEYS) do redis.call('ZREM',key,ARGV[1]) end return 1`;
export interface PartnerBudget { key: string; perMinute: number; burst: number }
export interface PartnerConcurrencyBudget { key: string; limit: number }
export function createPartnerRedis(url: string) {
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 1000, commandTimeout: 1500, maxRetriesPerRequest: 0,
    enableOfflineQueue: false, retryStrategy: (attempt) => Math.min(attempt * 200, 2000) });
  // Callers record a safe dependency outcome, never the URL/password/error body.
  redis.on("error", () => undefined);
  return redis;
}
async function awaitInitialConnection(redis: Redis) {
  if (redis.status === "ready") return;
  // A lazy runtime may receive its first request before connect() completes.
  // Wait only for that bounded handshake; an outage must not queue commands.
  if (redis.status !== "connecting" && redis.status !== "connect") throw new PartnerError("dependency_unavailable");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); redis.off("ready", ready); redis.off("close", failed); redis.off("error", failed); };
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new PartnerError("dependency_unavailable")); };
    const timer = setTimeout(failed, 1000);
    redis.once("ready", ready); redis.once("close", failed); redis.once("error", failed);
  });
}
export async function enforcePartnerQuota(redis: Redis, budgets: PartnerBudget[]) {
  if (!budgets.length || budgets.some((b) => !Number.isSafeInteger(b.perMinute) || b.perMinute < 1 || !Number.isSafeInteger(b.burst) || b.burst < 1)) {
    throw new PartnerError("dependency_unavailable");
  }
  try {
    await awaitInitialConnection(redis);
    const wait = Number(await redis.eval(takeBuckets, budgets.length, ...budgets.map((b) => b.key), ...budgets.flatMap((b) => [b.perMinute, b.burst])));
    if (wait > 0) throw new PartnerError("rate_limit_exceeded", wait);
  } catch (error) {
    if (error instanceof PartnerError) throw error;
    throw new PartnerError("dependency_unavailable");
  }
}
export async function acquirePartnerMutation(redis: Redis, budgets: PartnerConcurrencyBudget[], requestId: string) {
  if (!budgets.length || budgets.some((b) => !Number.isSafeInteger(b.limit) || b.limit < 1)) throw new PartnerError("dependency_unavailable");
  const keys = budgets.map((b) => b.key);
  try {
    await awaitInitialConnection(redis);
    const acquired = Number(await redis.eval(acquireLease, keys.length, ...keys, requestId, 15_000, ...budgets.map((b) => b.limit)));
    if (acquired !== 1) throw new PartnerError("mutation_busy");
  } catch (error) {
    if (error instanceof PartnerError) throw error;
    throw new PartnerError("dependency_unavailable");
  }
  // The owning transaction uses the PG16-compatible deadline wrapper. This
  // 15s lease is admission control/crash recovery, not a guarantee that a DB
  // session or its locks ended: server disconnect detection can be delayed.
  // PostgreSQL locks and idempotency remain the correctness boundary.
  return async () => { await redis.eval(releaseLease, keys.length, ...keys, requestId); };
}
