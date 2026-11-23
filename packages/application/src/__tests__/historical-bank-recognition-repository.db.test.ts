import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { shutdownPlatformDb } from "../platform-db";
import { completeSale } from "../services/order-service";
import { appendHistoricalBankRecognitionWithClientV1 } from "../services/historical-bank-recognition-repository";
import { sha256Canonical } from "../services/historical-bank-recognition-contract";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const scope = {
  scopeKind: "operating" as const,
  merchantId: "merchant_default",
  storeId: `db-test:historical-repo:${runId}:store`,
  stockLocationId: `db-test:historical-repo:${runId}:stock`,
};
const actor = {
  operatorId: "op_owner",
  role: "owner",
  displayName: "Historical recognition DB test",
  organizationId: "org_default",
};

const originalManualFlag = process.env.MANUAL_BANK_CONFIRMATION_ENABLED;
let client: PoolClient;

beforeAll(async () => {
  process.env.MANUAL_BANK_CONFIRMATION_ENABLED = "true";
  client = await connectPlatformClient();
  await assertSafeTestDatabaseSentinel(client,requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL));
  for(const filename of ["035_historical_bank_recognition.sql","036_historical_bank_recognition_runtime_trigger_guard.sql"]){
    const sql=await readFile(`db/migrations/${filename}`,"utf8");
    const ledger=await client.query("SELECT checksum FROM app.schema_migrations WHERE filename=$1",[filename]);
    if(ledger.rows.length){
      expect(ledger.rows).toEqual([{checksum:createHash("sha256").update(sql).digest("hex")}]);
    }else{
      const newer=await client.query("SELECT EXISTS(SELECT 1 FROM app.schema_migrations WHERE filename>$1) AS present",[filename]);
      if(newer.rows[0].present)throw new Error("Historical fixture cannot downgrade a newer migration profile");
      await client.query(sql);
    }
  }
  const inventory = (await client.query("SELECT inventory_item_id FROM public.product_variant_inventory_item WHERE variant_id='var_mint_20' AND deleted_at IS NULL LIMIT 1")).rows[0];
  if (!inventory) throw new Error("Seeded var_mint_20 required for historical fixture");
  await client.query("INSERT INTO public.stock_location(id,name) VALUES($1,'Historical repository fixture')", [scope.stockLocationId]);
  await client.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,is_primary,status) VALUES($1,$2,'Historical repository fixture',$3,false,'active')", [scope.storeId, scope.merchantId, scope.stockLocationId]);
  await client.query("INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity,incoming_quantity) VALUES($1,$2,$3,100,0,0)", [`historical-repo:${runId}:level`, inventory.inventory_item_id, scope.stockLocationId]);
});

afterAll(async () => {
  if (originalManualFlag === undefined) delete process.env.MANUAL_BANK_CONFIRMATION_ENABLED;
  else process.env.MANUAL_BANK_CONFIRMATION_ENABLED = originalManualFlag;
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("historical bank recognition PostgreSQL repository", () => {
  it("appends one proven receipt to an existing pending initial obligation without another sale event", async () => {
    const sale = await completeSale({ "idempotency-key": `db-test:${runId}:pending` }, {
      customerId: "cus_demo",
      customerMode: "linked",
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      paymentMethod: "bank_transfer",
      amountReceived: 0,
      salesChannel: "pos_counter",
    }, actor, scope);
    expect(sale.response.data.paymentStatus).toBe("pending");
    const orderId = sale.response.data.orderId;
    const source = await client.query<Record<string, unknown>>(`
      SELECT pending.id::text AS pending_event_id,
             obligations.id::text AS obligation_id,
             pending.commercial_revision_id::text AS commercial_revision_id,
             pending.source_type, pending.source_id, pending.source_occurred_at,
             pending.amount_minor, pending.currency_code, pending.minor_unit_exponent,
             components.tax_mode, components.merchandise_gross_minor, components.discount_minor,
             components.merchandise_net_minor, components.shipping_minor,
             components.merchandise_vat_minor, components.shipping_vat_minor,
             components.vat_minor, components.unclassified_minor, components.total_minor
      FROM app.payment_events pending
      JOIN app.commercial_obligations obligations
        ON obligations.merchant_id = pending.merchant_id
       AND obligations.store_id = pending.store_id
       AND obligations.order_id = pending.order_id
       AND obligations.commercial_revision_id = pending.commercial_revision_id
      JOIN app.payment_event_component_allocations components ON components.payment_event_id = pending.id
      WHERE pending.order_id = $1 AND pending.status = 'pending' AND pending.method = 'manual_bank'
      LIMIT 1
    `, [orderId]);
    const row = source.rows[0]!;
    const components = {
      taxMode: String(row.tax_mode) as "inclusive" | "exclusive",
      merchandiseGrossMinor: Number(row.merchandise_gross_minor),
      discountMinor: Number(row.discount_minor),
      merchandiseNetMinor: Number(row.merchandise_net_minor),
      shippingMinor: Number(row.shipping_minor),
      merchandiseVatMinor: Number(row.merchandise_vat_minor),
      shippingVatMinor: Number(row.shipping_vat_minor),
      vatMinor: Number(row.vat_minor),
      unclassifiedMinor: Number(row.unclassified_minor),
      totalMinor: Number(row.total_minor),
    };
    const economicOccurredAt = new Date(
      row.source_occurred_at instanceof Date ? row.source_occurred_at.getTime() : String(row.source_occurred_at),
    ).toISOString();
    const sourcePayloadSha256 = sha256Canonical({
      sourcePendingPaymentEventId: row.pending_event_id,
      sourceObligationId: row.obligation_id,
      sourceCommercialRevisionId: row.commercial_revision_id,
      baseCommercialRevisionId: null,
      sourceType: row.source_type,
      sourceId: row.source_id,
      merchantId: scope.merchantId,
      storeId: scope.storeId,
      orderId,
      obligationKind: "order_charge",
      currencyCode: String(row.currency_code).toUpperCase(),
      minorUnitExponent: Number(row.minor_unit_exponent),
      amountMinor: Number(row.amount_minor),
      sourceOccurredAt: economicOccurredAt,
      components,
      delta: null,
    });
    const manifestSha256 = sha256Canonical({ manifest: runId });
    const recognitionRunId = randomUUID();
    await client.query(`
      INSERT INTO app.historical_bank_recognition_runs (
        id, schema_id, manifest_sha256, source_dataset_sha256, owner_declaration_sha256,
        execution_permit_sha256, target_environment, target_database_identity_sha256,
        source_application_sha, cutoff_at, report_as_of, date_policy, expected_recognized_count,
        expected_already_satisfied_count, expected_exception_count, actor
      ) VALUES ($1::uuid, 'snus-historical-bank-recognition/v1', $2, $3, $4, $5, 'disposable', $6, $7, now(), now(), 'reliable_receipt_else_original_economic_time_v1', 1, 0, 0, $8)
    `, [
      recognitionRunId, manifestSha256, sha256Canonical({ source: runId }), sha256Canonical({ owner: runId }), sha256Canonical({ permit: runId }),
      sha256Canonical({ database: runId }), "2".repeat(40), actor.operatorId,
    ]);
    const beforeOutbox = await client.query(`
      SELECT count(*)::int AS count FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'sale.created'
    `, [orderId]);
    const item = {
      rowNumber: 1,
      itemId: randomUUID(),
      decision: "recognize" as const,
      reasonCode: "owner_declared_received",
      recognitionKind: "initial" as const,
      merchantId: scope.merchantId,
      storeId: scope.storeId,
      orderId,
      sourcePendingPaymentEventId: String(row.pending_event_id),
      sourceObligationId: String(row.obligation_id),
      sourceCommercialRevisionId: String(row.commercial_revision_id),
      targetPaymentEventId: randomUUID(),
      targetSourceType: "historical_bank_initial_recognition" as const,
      targetSourceId: `historical-bank:v1:${runId}`,
      targetIdempotencyKey: `historical-bank:v1:${runId}:receipt`,
      evidenceFingerprint: "3".repeat(64),
      sourcePayloadSha256,
      componentBasisFingerprint: sha256Canonical(components),
      ownerDeclarationReferenceSha256: sha256Canonical({ owner: runId, source: row.pending_event_id }),
      currencyCode: String(row.currency_code).toUpperCase(),
      minorUnitExponent: Number(row.minor_unit_exponent),
      amountMinor: Number(row.amount_minor),
      economicOccurredAt,
      components,
    };
    await expect(appendHistoricalBankRecognitionWithClientV1(client, {
      runId: recognitionRunId,
      manifestSha256: sha256Canonical({ manifest: `${runId}:wrong` }),
      actor: actor.operatorId,
      ownerDeclarationSha256: sha256Canonical({ owner: runId }),
    }, item)).rejects.toThrow("run binding drift");
    const applied = await appendHistoricalBankRecognitionWithClientV1(client, {
      runId: recognitionRunId,
      manifestSha256,
      actor: actor.operatorId,
      ownerDeclarationSha256: sha256Canonical({ owner: runId }),
    }, item);
    expect(applied).toMatchObject({ outcome: "inserted", paymentEventId: item.targetPaymentEventId });
    const receipt = await client.query(`
      SELECT events.status, events.evidence_type, events.method,
             count(allocations.id)::int AS allocation_count,
             coalesce(sum(allocations.amount_minor), 0)::text AS allocated_minor
      FROM app.payment_events events
      LEFT JOIN app.payment_event_allocations allocations ON allocations.payment_event_id = events.id
      WHERE events.id = $1::uuid
      GROUP BY events.id
    `, [item.targetPaymentEventId]);
    expect(receipt.rows[0]).toMatchObject({
      status: "posted", evidence_type: "owner_historical_recognition", method: "manual_bank",
      allocation_count: 1, allocated_minor: String(item.amountMinor),
    });
    const replay = await appendHistoricalBankRecognitionWithClientV1(client, {
      runId: recognitionRunId,
      manifestSha256,
      actor: actor.operatorId,
      ownerDeclarationSha256: sha256Canonical({ owner: runId }),
    }, item);
    expect(replay).toMatchObject({ outcome: "replayed", paymentEventId: item.targetPaymentEventId });
    const afterOutbox = await client.query(`
      SELECT count(*)::int AS count FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'sale.created'
    `, [orderId]);
    expect(afterOutbox.rows[0]?.count).toBe(beforeOutbox.rows[0]?.count);
  });
});
