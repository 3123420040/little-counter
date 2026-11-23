import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { partnerScopes, type PartnerOrderRequest } from "@medusa-snus/contracts/partner-api";
import { requireSafeTestDatabaseTarget, assertSafeTestDatabaseSentinel } from "../../db/test-database-target";
import { readPartnerIdentity, selectPartnerStore } from "../../partner/registry";
import { bookPartnerOrderForClient } from "../../partner/booking";
import type { PartnerKeyring } from "../../partner/fingerprints";
import { withPartnerTransaction } from "../../partner/transaction";

process.once("message", async (input: { prefix: string; body: PartnerOrderRequest; key: string; keys: PartnerKeyring; commit: boolean }) => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  const pool = new Pool({ connectionString: target.connectionString, max: 1 });
  const owner = await pool.connect();
  try { await assertSafeTestDatabaseSentinel(owner, target); } finally { owner.release(); }
  try {
    const result = await withPartnerTransaction(pool, async db => {
      await db.query("SET LOCAL ROLE snus_partner_api");
      const token = { issuer: `https://${input.prefix}.invalid`, clientId: "reads", subject: "subject", scopes: partnerScopes, expiresAt: 9999999999 };
      const requestId = `req_${randomUUID()}`;
      let identity = await readPartnerIdentity(db, token, "sandbox", requestId, "d".repeat(32));
      await db.query("SELECT integration.lock_authorization($1,$2,$3)", [identity.integrationId, identity.registryClientId, input.body.store_id]);
      identity = await readPartnerIdentity(db, token, "sandbox", requestId, "d".repeat(32));
      const booked = await bookPartnerOrderForClient(db, selectPartnerStore(identity, input.body.store_id, "orders:write", true), input.keys, input.body, input.key);
      if (!input.commit) {
        process.send?.({ phase: "before_commit", orderId: booked.body.data.order_id });
        // The parent kills the real process here; runtime deadline remains the fallback.
        await new Promise<never>(() => undefined);
      }
      return booked;
    }, { timeoutMs: 5000, statementTimeoutMs: 3000 });
    process.send?.({ phase: "committed", orderId: result.body.data.order_id });
    // The IPC/pool stay live until the parent kills this committed process.
  } catch {
    process.send?.({ phase: "failed" });
    await pool.end(); process.exitCode = 1; process.disconnect();
  }
});
