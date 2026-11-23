import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_METRIC_TIME_BASIS_V2 } from "@medusa-snus/contracts";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { readDashboardAccountingSliceV1 } from "../services/dashboard-accounting-slice";
import { readDashboardCommercialSliceV1 } from "../services/dashboard-commercial-slice";
import { readDashboardPaymentFlowSliceV1 } from "../services/dashboard-payment-flow-slice";
import { readDashboardRecordedCollectionSliceV1 } from "../services/dashboard-recorded-collection-slice";
import { readCreatorOptionsV1 } from "../services/creator-sales-overview-service";
import type { DashboardSnapshotReadContext } from "../services/dashboard-report-foundation";

let pool: Pool;
let client: PoolClient;
let merchant: string;
let store: string;
const before = "2026-08-30T10:00:00.000Z";
const during = "2026-09-01T10:00:00.000Z";
const asOf = "2026-09-02T10:00:00.000Z";

function context(): DashboardSnapshotReadContext {
  return {
    normalizedScope: { scopeKind: "report", merchantId: merchant, storeIds: [store] },
    localDateRange: { from: "2026-09-01", to: "2026-09-01", inclusiveDays: 1 },
    storeTimeWindows: [{ storeId: store, timeZone: "Asia/Ho_Chi_Minh", startInclusive: "2026-08-31T17:00:00.000Z", endExclusive: "2026-09-01T17:00:00.000Z" }],
    reportAsOf: asOf, metricTimeBasis: DASHBOARD_METRIC_TIME_BASIS_V2,
  };
}
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  // The shared Internet UAT also has a sentinel and _test suffix. Both are
  // insufficient: explicitly deny its identities before connecting or writing.
  if (target.databaseName === "medusa_snus_v19_internet_uat_test" || target.port === "55449"
    || target.composeProject === "medusa-snus-v19-internet-uat"
    || target.volumeName === "medusa-snus-v19-internet-uat-postgres-data") throw new Error("Shared UAT is not disposable");
  pool = new Pool({ connectionString: target.connectionString });
  client = await pool.connect();
  await assertSafeTestDatabaseSentinel(client, target);
});
beforeEach(async () => {
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '5s'");
  merchant = `ov2-${randomUUID()}`; store = `store-${randomUUID()}`;
  await client.query("INSERT INTO app.merchants(id,display_name,legacy_organization_id) VALUES ($1,$1,$1)", [merchant]);
  await client.query("INSERT INTO public.stock_location(id,name) VALUES ($1,$1)", [store]);
  await client.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id) VALUES ($1,$2,$1,$1)", [store, merchant]);
});
afterEach(async () => { await client?.query("ROLLBACK"); });
afterAll(async () => { client?.release(); await pool?.end(); });

async function order(at = during) {
  const id = `order-${randomUUID()}`;
  await client.query('INSERT INTO public."order"(id,currency_code,merchant_id,store_id,created_at) VALUES ($1,\'vnd\',$2,$3,$4)', [id, merchant, store, at]);
  return id;
}
async function creation(orderId: string, actorId: string, actorType = "staff") {
  await client.query(`INSERT INTO audit.events(actor_type,actor_id,action,subject_type,subject_id,correlation_id,merchant_id,store_id)
    VALUES ($1,$2,'order.created','order',$3,$3,$4,$5)`, [actorType,actorId,orderId,merchant,store]);
}
async function revision(orderId: string, n: number, known: boolean, options: { at?: string; cancelled?: boolean; quantity?: number; currency?: string; recordedAt?: string; price?: number; cost?: number } = {}) {
  const id = randomUUID(); const at = options.at ?? during;
  const sourceType = options.cancelled ? "order_cancellation" : n === 0 ? "original_order" : "order_correction";
  const sourceId = n === 0 || options.cancelled ? orderId : `correction-${randomUUID()}`;
  if (sourceType === "order_correction") {
    await client.query("INSERT INTO app.order_corrections(id,order_id,revision,base_revision,status,reason,before_totals,after_totals,total_delta,created_by) VALUES ($1,$2,$3,$4,'applied','synthetic proof','{}','{}',0,'test')", [sourceId,orderId,n,n-1]);
  }
  await client.query(`INSERT INTO app.order_commercial_revisions
    (id,merchant_id,store_id,order_id,revision,source_type,source_id,commercial_state,currency_code,minor_unit_exponent,effective_at,recorded_at,idempotency_key,data_quality)
    VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$1::text,$12)`,
  [id,merchant,store,orderId,n,sourceType,sourceId,options.cancelled ? "cancelled" : "active",options.currency ?? "VND",at,options.recordedAt ?? at,known ? "complete" : "partial"]);
  const quantity = options.quantity ?? 1; const amount = quantity * (options.price ?? 1000);
  await client.query(`INSERT INTO app.order_commercial_revision_components
    (revision_id,merchant_id,store_id,order_id,revision,currency_code,minor_unit_exponent,tax_mode,merchandise_gross_minor,discount_minor,merchandise_net_minor,shipping_minor,merchandise_vat_minor,shipping_vat_minor,vat_minor,unclassified_minor,total_minor,recorded_at)
    VALUES ($1,$2,$3,$4,$5,$6,0,'exclusive',$7,0,$7,0,0,0,0,0,$7,$8)`, [id,merchant,store,orderId,n,options.currency ?? "VND",amount,at]);
  await client.query(`INSERT INTO app.order_commercial_revision_lines
    (revision_id,merchant_id,store_id,order_id,revision,line_key,sku_snapshot,title_snapshot,quantity,unit_price_minor,line_total_minor,cost_minor,cost_evidence_id,recorded_at)
    VALUES ($1,$2,$3,$4,$5,'one','SYNTHETIC','Synthetic proof',$6,$11,$7,$8,$9,$10)`,
  [id,merchant,store,orderId,n,quantity,amount,known ? (options.cost ?? 600) : null,known ? `evidence-${id}` : null,at,options.price ?? 1000]);
  return { id, orderId, sourceId, sourceType };
}
async function journal(ref: { sourceType: string; sourceId: string }, revenue: number, cogs: number, options: { unbalanced?: boolean; at?: string } = {}) {
  const id = randomUUID(); const at = options.at ?? during;
  const type = ref.sourceType === "original_order" ? "order" : ref.sourceType;
  await client.query(`INSERT INTO accounting.journal_entries(id,entry_number,entry_date,reference_type,reference_id,description,status,posted_at,created_at,created_by,merchant_id,store_id)
    VALUES ($1::uuid,$1::text,'2026-09-01',$2,$3,'Synthetic proof','posted',$4,$4,'test',$5,$6)`, [id,type,ref.sourceId,at,merchant,store]);
  for (const [code, signed] of [["5111", -revenue], ["6321", cogs], ["1111", revenue - cogs + (options.unbalanced ? 1 : 0)]] as const) {
    if (signed === 0) continue;
    await client.query(`INSERT INTO accounting.journal_lines(journal_entry_id,account_id,debit_amount,credit_amount)
      SELECT $1,id,$3,$4 FROM accounting.accounts WHERE code=$2`, [id,code,Math.max(0,signed),Math.max(0,-signed)]);
  }
  return id;
}
async function accounting() {
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  const result = await readDashboardAccountingSliceV1(client, context());
  return { exact: result.currencies.find(c => c.currencyCode === "VND")!, coverage: result.profitCoverage!.find(c => c.currencyCode === "VND")!.coverage };
}
async function payment(rev: Awaited<ReturnType<typeof revision>>, kind: "charge" | "refund" | "reversal" | "chargeback", method: string, amount: number, at = during) {
  const id = randomUUID();
  await client.query(`INSERT INTO app.payment_events(id,merchant_id,store_id,order_id,commercial_revision_id,kind,status,method,evidence_type,evidence_fingerprint,currency_code,minor_unit_exponent,amount_minor,idempotency_key,source_type,source_id,source_occurred_at,recorded_at)
    VALUES ($1::uuid,$2,$3,$4,$5,$6,'posted',$7,$8,$9,'VND',0,$10,$1::text,'synthetic',$1::text,$11,$11)`,
  [id,merchant,store,rev.orderId,rev.id,kind,method,kind !== "charge" ? "negative_collection_confirmed" : method === "cash" ? "cash_receipt" : method === "manual_bank" ? "manual_verified" : "provider_webhook_success","a".repeat(64),amount,at]);
  await client.query(`INSERT INTO app.payment_event_evidence(payment_event_id,merchant_id,store_id,evidence_type,source_system,source_reference,verification_status,evidence_fingerprint,source_occurred_at)
    SELECT id,merchant_id,store_id,evidence_type,'synthetic',id::text,'verified',evidence_fingerprint,source_occurred_at FROM app.payment_events WHERE id=$1`,[id]);
  let obligation = randomUUID();
  if (kind !== "charge") {
    const original = await payment(rev,"charge",method,amount,before);
    obligation = (await client.query<{ obligation_id: string }>("SELECT obligation_id FROM app.payment_event_allocations WHERE payment_event_id=$1",[original])).rows[0]!.obligation_id;
  } else await client.query(`INSERT INTO app.commercial_obligations(id,merchant_id,store_id,order_id,commercial_revision_id,obligation_kind,currency_code,minor_unit_exponent,amount_minor,idempotency_key,source_type,source_id,source_occurred_at)
    VALUES ($1::uuid,$2,$3,$4,$5,'order_charge','VND',0,$6,$1::text,'synthetic',$1::text,$7)`,[obligation,merchant,store,rev.orderId,rev.id,amount,at]);
  await client.query(`INSERT INTO app.payment_event_allocations(merchant_id,store_id,obligation_id,payment_event_id,allocation_kind,currency_code,minor_unit_exponent,amount_minor,idempotency_key,allocated_at)
    VALUES ($1,$2,$3,$4::uuid,$5,'VND',0,$6,$4::text,$7)`,[merchant,store,obligation,id,kind === "charge" ? "collection" : kind,amount,at]);
  if (kind === "charge") await client.query(`INSERT INTO app.payment_event_component_allocations(payment_event_id,commercial_revision_id,merchant_id,store_id,currency_code,minor_unit_exponent,tax_mode,merchandise_gross_minor,discount_minor,merchandise_net_minor,shipping_minor,merchandise_vat_minor,shipping_vat_minor,vat_minor,unclassified_minor,total_minor)
    VALUES ($1,$2,$3,$4,'VND',0,'exclusive',$5,0,$5,0,0,0,0,0,$5)`,[id,rev.id,merchant,store,amount]);
  return id;
}

describe("OV2 real PostgreSQL immutable coverage and independent fixture oracle", () => {
  it("uses the same trusted creator OR-set for quantities, payment events, collections and accounting", async () => {
    const a = await revision(await order(),0,true,{quantity:2});
    const b = await revision(await order(),0,true,{quantity:9});
    const partner = await revision(await order(),0,true,{quantity:7});
    const ambiguous = await revision(await order(),0,true,{quantity:12});
    await creation(a.orderId,"creator_a"); await creation(b.orderId,"creator_b");
    await creation(partner.orderId,"creator_a","partner");
    await creation(ambiguous.orderId,"creator_a"); await creation(ambiguous.orderId,"creator_a");
    for (const [rev,qty] of [[a,2],[b,9],[partner,7],[ambiguous,12]] as const) await journal(rev,qty*1000,qty*600);
    await payment(a,"charge","cash",500); await payment(a,"charge","manual_bank",1500);
    await payment(b,"charge","cash",9000); await payment(partner,"charge","cash",7000);
    await payment(ambiguous,"charge","cash",12000);
    const previousDay = await revision(await order(before),0,true,{at:before});
    await creation(previousDay.orderId,"creator_a");
    await payment(previousDay,"charge","cash",1000);
    const cancelled = await order();
    await creation(cancelled,"creator_a"); await revision(cancelled,0,true,{quantity:4});
    await revision(cancelled,1,true,{quantity:4,cancelled:true});
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const selected = { mode: "selected" as const, creatorOperatorIds: ["creator_a"] };
    expect(await readCreatorOptionsV1(client, context().normalizedScope)).toEqual([
      { operatorId: "creator_a", displayName: "creator_a", status: "historical" },
      { operatorId: "creator_b", displayName: "creator_b", status: "historical" },
    ]);
    const commercial = await readDashboardCommercialSliceV1(client,context(),selected);
    expect(commercial.currencies[0]).toMatchObject({ validOrderCount: 1, cancelledOrderCohortCount: 1, effectiveItemQuantity: 2, currentOrderGrossValueMinor: 2000 });
    const both = await readDashboardCommercialSliceV1(client,context(),{ mode: "selected", creatorOperatorIds: ["creator_a","creator_b"] });
    expect(both.currencies[0]).toMatchObject({ effectiveItemQuantity: 11, currentOrderGrossValueMinor: 11000 });
    const payments = await readDashboardPaymentFlowSliceV1(client,context(),selected);
    expect(payments[0]!.methods).toEqual(expect.arrayContaining([
      expect.objectContaining({method:"cash",postedChargeOrderCount:2,recordedNetCollectionsMinor:1500}),
      expect.objectContaining({method:"manual_bank",postedChargeOrderCount:1,recordedNetCollectionsMinor:1500}),
    ]));
    const collections = await readDashboardRecordedCollectionSliceV1(client,context(),{enabled:true},selected);
    expect(collections).toMatchObject({ enabled: true, data: {currencies:[{recordedGrossCollectionsMinor:3000}]} });
    const accounting = await readDashboardAccountingSliceV1(client,context(),selected);
    expect(accounting.currencies[0]).toMatchObject({status:"unavailable"});
    expect(accounting.currencies[0]).not.toHaveProperty("grossProfitMinor");
    expect(accounting.profitCoverage![0]!.coverage).toMatchObject({status:"unavailable",totalJournalCount:1,verifiedSubsetGrossProfitMinor:null});
  });
  it("exact revenue 1000 - COGS 600 = profit 400", async () => {
    await journal(await revision(await order(),0,true),1000,600);
    expect(await accounting()).toMatchObject({ exact: { grossProfitMinor: 400, grossMarginPercent: 40 }, coverage: { status: "exact", totalJournalCount: 1, coveredJournalCount: 1, exactGrossProfitMinor: 400 } });
  });
  it("partial uses 1000 - 600; excluded revenue 9000 never enters numerator", async () => {
    await journal(await revision(await order(),0,true),1000,600);
    await journal(await revision(await order(),0,false),9000,0);
    expect(await accounting()).toMatchObject({ exact: { status: "unavailable" }, coverage: { status: "partial", totalJournalCount: 2, coveredJournalCount: 1, excludedJournalCount: 1, exactGrossProfitMinor: null, verifiedSubsetRevenueExcludingVatMinor: 1000, verifiedSubsetCogsRecognizedMinor: 600, verifiedSubsetGrossProfitMinor: 400 } });
  });
  it("0/N is unavailable and valid 0/0 is exact zero with null margin", async () => {
    expect(await accounting()).toMatchObject({ exact: { grossProfitMinor: 0, grossMarginPercent: null }, coverage: { status: "exact", totalJournalCount: 0 } });
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await journal(await revision(await order(),0,false),1000,0);
    expect(await accounting()).toMatchObject({ coverage: { status: "unavailable", coveredJournalCount: 0, verifiedSubsetGrossProfitMinor: null } });
  });
  it.each([true,false])("signed correction with outside-period original known=%s", async (known) => {
    const id = await order(before); await revision(id,0,known,{at:before});
    await journal(await revision(id,1,true,{price:500,cost:300}),-500,-300);
    const result = await accounting();
    expect(result.coverage.status).toBe(known ? "exact" : "unavailable");
    expect(result.coverage.verifiedSubsetGrossProfitMinor).toBe(known ? -200 : null);
  });
  it.each([true,false])("cancellation reversal requires outside-period lineage known=%s", async (known) => {
    const id = await order(before); await revision(id,0,known,{at:before});
    await journal(await revision(id,1,true,{cancelled:true}),-1000,-600);
    expect((await accounting()).coverage.verifiedSubsetGrossProfitMinor).toBe(known ? -400 : null);
  });
  it.each([true,false])("refund revenue reversal requires source lineage known=%s", async (known) => {
    const rev = await revision(await order(before),0,known,{at:before});
    const eventId = await payment(rev,"refund","cash",200); const entry = randomUUID();
    await client.query(`INSERT INTO app.payment_entries(id,order_id,direction,method,amount,status,created_by,merchant_id,store_id,metadata)
      VALUES ($1,$2,'refund','cash',200,'posted','test',$3,$4,jsonb_build_object('canonicalPaymentEventId',$5::text))`,[entry,rev.orderId,merchant,store,eventId]);
    await journal({sourceType:"refund",sourceId:entry},-200,0);
    expect((await accounting()).coverage.verifiedSubsetGrossProfitMinor).toBe(known ? -200 : null);
  });
  it.each(["unbalanced","fractional","unmapped","unsupported"])("hard %s failure suppresses a known subset", async (kind) => {
    await journal(await revision(await order(),0,true),1000,600);
    if (kind === "unmapped" || kind === "unsupported") await journal({sourceType:kind === "unmapped" ? "order" : "unknown",sourceId:randomUUID()},1000,600,{at:before});
    else await journal(await revision(await order(),0,true),kind === "fractional" ? 1000.5 : 1000,600,{unbalanced:kind === "unbalanced"});
    expect((await accounting()).coverage).toMatchObject({status:"unavailable",verifiedSubsetGrossProfitMinor:null});
  });
  it.each(["order","order_correction","refund","unsupported"])("selected creator retains quality warnings for an unattributable %s journal", async (sourceType) => {
    const a = await revision(await order(),0,true);
    await creation(a.orderId,"creator_a"); await journal(a,1000,600);
    await journal({sourceType,sourceId:randomUUID()},1000,600,{at:before});
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const result = await readDashboardAccountingSliceV1(client,context(),{mode:"selected",creatorOperatorIds:["creator_a"]});
    expect(result.profitCoverage!.find(c=>c.currencyCode==="VND")!.coverage)
      .toMatchObject({status:"unavailable",verifiedSubsetGrossProfitMinor:null});
  });
  it("does not allocate a trusted nonselected creator's defective journal or suppress the selected creator's exact profit", async () => {
    const a = await revision(await order(),0,true), b = await revision(await order(),0,false);
    await creation(a.orderId,"creator_a"); await creation(b.orderId,"creator_b");
    await journal(a,1000,600); await journal(b,9000,0);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const result = await readDashboardAccountingSliceV1(client,context(),{mode:"selected",creatorOperatorIds:["creator_a"]});
    expect(result.profitCoverage!.find(c=>c.currencyCode==="VND")!.coverage)
      .toMatchObject({status:"exact",totalJournalCount:1,exactGrossProfitMinor:400});
  });
  it("unsupported currency never supplies profit to VND", async () => {
    await journal(await revision(await order(),0,true,{currency:"XYZ"}),1000,600);
    const result = await readDashboardAccountingSliceV1(client,context());
    expect(result.profitCoverage!.find(c => c.currencyCode === "XYZ")!.coverage).toMatchObject({status:"unavailable",verifiedSubsetGrossProfitMinor:null});
    expect(result.profitCoverage!.find(c => c.currencyCode === "VND")!.coverage.exactGrossProfitMinor).toBe(0);
  });
  it("future-recorded provenance cannot authorize an earlier journal", async () => {
    await journal(await revision(await order(),0,true,{recordedAt:"2026-09-03T10:00:00Z"}),1000,600);
    expect((await accounting()).coverage.status).toBe("unavailable");
  });
  it("latest corrected quantity and cancelled zero keep original order date", async () => {
    const id = await order(); await revision(id,0,true,{quantity:2}); await revision(id,1,true,{quantity:5});
    const cancelled = await order(); await revision(cancelled,0,true,{quantity:3}); await revision(cancelled,1,true,{cancelled:true,quantity:3});
    const outside = await order(before); await revision(outside,0,true,{at:before}); await revision(outside,1,true,{quantity:9});
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const result = await readDashboardCommercialSliceV1(client,context());
    expect(result.currencies[0]!.effectiveItemQuantity).toBe(5);
  });
  it("Bank distinct order count dedupes multiple charges and all negative kinds retain sign", async () => {
    const rev = await revision(await order(),0,true);
    await payment(rev,"charge","manual_bank",100); await payment(rev,"charge","manual_bank",100);
    for (const kind of ["refund","reversal","chargeback"] as const) await payment(rev,kind,"manual_bank",100);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const rows = await readDashboardPaymentFlowSliceV1(client,context());
    expect(rows[0]!.methods).toMatchObject([{method:"manual_bank",postedChargeOrderCount:1,postedNegativeEventCount:3,recordedNetCollectionsMinor:-100}]);
  });
  it("rejects complete-looking cost proof that cannot explain the signed correction", async () => {
    const id = await order(before); await revision(id,0,true,{at:before});
    await journal(await revision(id,1,true,{price:500,cost:300}),-500,-100);
    expect((await accounting()).coverage).toMatchObject({status:"unavailable",verifiedSubsetGrossProfitMinor:null});
  });

  it("decreasing correction quantity uses latest active units", async () => {
    const id=await order();await revision(id,0,true,{quantity:5});await revision(id,1,true,{quantity:2});
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    expect((await readDashboardCommercialSliceV1(client,context())).currencies[0]!.effectiveItemQuantity).toBe(2);
  });
  it("same store IDs cannot bypass merchant accounting scope", async () => {
    await journal(await revision(await order(),0,true),1000,600);
    const other={...context(),normalizedScope:{...context().normalizedScope,merchantId:'outside-synthetic-merchant'}};
    expect((await readDashboardAccountingSliceV1(client,other)).profitCoverage![0]!.coverage).toMatchObject({status:'exact',totalJournalCount:0,exactGrossProfitMinor:0});
  });
  it("provider offsetting activity retains event counts at zero net", async () => {
    const rev=await revision(await order(),0,true);await payment(rev,'charge','provider',100);await payment(rev,'refund','provider',100);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    expect((await readDashboardPaymentFlowSliceV1(client,context()))[0]!.methods).toMatchObject([{method:'provider',postedChargeOrderCount:1,postedNegativeEventCount:1,recordedNetCollectionsMinor:0}]);
  });
  it("database rejects legacy Bank alias instead of double-counting same order", async () => {
    const rev=await revision(await order(),0,true);await payment(rev,'charge','manual_bank',100);
    await expect(payment(rev,'charge','bank_transfer',100)).rejects.toThrow();
  });
  it("unsafe source units cannot produce a safe-looking subset", async () => {
    await journal(await revision(await order(),0,true,{cost:Number.MAX_SAFE_INTEGER,quantity:2}),1000,600);
    await expect(accounting()).rejects.toThrow();
  });

});
