import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export interface CreatorSalesOracle {
  orders: Array<{
    orderId: string; merchantId: string; storeId: string; createdAt: string;
    creatorOperatorId: string | null; creatorKind: string; sourceStatus: string;
    originalQuantity?: number; effectiveRevisionQuantity: number; currentCommercialState: string;
    plannedPaymentMethod: string | null; refundPayableAsOfMinor: number;
    paymentEvents: Array<{ kind: string; method: string; amountMinor: number; sourceOccurredAt: string; recordedAt: string }>;
  }>;
}

/** Uses the same canonical SQL bundles as the existing financial DB fixtures. */
export async function seedCreatorSalesOracle(client: PoolClient, oracle: CreatorSalesOracle, prefix: string) {
  const scoped = (id: string) => `${prefix}-${id}`;
  for (const merchant of new Set(oracle.orders.map((order) => order.merchantId))) {
    await client.query("INSERT INTO app.merchants(id,display_name,legacy_organization_id) VALUES($1,$1,$1)", [scoped(merchant)]);
  }
  for (const order of oracle.orders.filter((order, index, all) => all.findIndex((candidate) => candidate.storeId === order.storeId) === index)) {
    await client.query("INSERT INTO public.stock_location(id,name) VALUES($1,$1)", [scoped(order.storeId)]);
    await client.query(`INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,metadata)
      VALUES($1,$2,$1,$1,'{"ownerSettings":{"timezone":"Asia/Ho_Chi_Minh"}}')`, [scoped(order.storeId), scoped(order.merchantId)]);
  }
  for (const order of oracle.orders) {
    const id = scoped(order.orderId), merchant = scoped(order.merchantId), store = scoped(order.storeId);
    await client.query(`INSERT INTO public."order"(id,status,currency_code,merchant_id,store_id,created_at,custom_display_id)
      VALUES($1,$2,'vnd',$3,$4,$5,$1)`, [id, order.sourceStatus, merchant, store, order.createdAt]);
    if (order.creatorOperatorId) await client.query(`INSERT INTO audit.events
      (actor_type,actor_id,action,subject_type,subject_id,correlation_id,merchant_id,store_id,created_at)
      VALUES($1,$2,'order.created','order',$3,$3,$4,$5,$6)`,
    [order.creatorKind, scoped(order.creatorOperatorId), id, merchant, store, order.createdAt]);
    const originalQuantity = order.originalQuantity ?? order.effectiveRevisionQuantity;
    let currentRevision = "", originalRevision = "";
    const revisions = [{ quantity: originalQuantity, cancelled: false },
      ...(order.originalQuantity !== undefined ? [{ quantity: order.effectiveRevisionQuantity, cancelled: order.currentCommercialState === "cancelled" }] : [])];
    for (const [number, revision] of revisions.entries()) {
      const revisionId = randomUUID();
      currentRevision = revisionId;
      if (number === 0) originalRevision = revisionId;
      const sourceType = number === 0 ? "original_order" : revision.cancelled ? "order_cancellation" : "order_correction";
      const sourceId = sourceType === "order_correction" ? `${id}-correction` : id;
      if (sourceType === "order_correction") await client.query(`INSERT INTO app.order_corrections
        (id,order_id,revision,base_revision,status,reason,before_totals,after_totals,total_delta,created_by)
        VALUES($1,$2,1,0,'applied','Synthetic oracle','{}','{}',-100000,$3)`, [sourceId,id,scoped("uat_staff_B")]);
      const at = number === 0 ? order.createdAt : "2026-10-18T05:00:00Z";
      await client.query(`INSERT INTO app.order_commercial_revisions
        (id,merchant_id,store_id,order_id,revision,source_type,source_id,commercial_state,currency_code,minor_unit_exponent,effective_at,recorded_at,idempotency_key,data_quality)
        VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,'VND',0,$9,$9,$1::text,'complete')`,
      [revisionId,merchant,store,id,number,sourceType,sourceId,revision.cancelled ? "cancelled" : "active",at]);
      const amount = revision.quantity * 100000;
      await client.query(`INSERT INTO app.order_commercial_revision_components
        (revision_id,merchant_id,store_id,order_id,revision,currency_code,minor_unit_exponent,tax_mode,merchandise_gross_minor,discount_minor,merchandise_net_minor,shipping_minor,merchandise_vat_minor,shipping_vat_minor,vat_minor,unclassified_minor,total_minor,recorded_at)
        VALUES($1,$2,$3,$4,$5,'VND',0,'exclusive',$6,0,$6,0,0,0,0,0,$6,$7)`, [revisionId,merchant,store,id,number,amount,at]);
      await client.query(`INSERT INTO app.order_commercial_revision_lines
        (revision_id,merchant_id,store_id,order_id,revision,line_key,sku_snapshot,title_snapshot,quantity,unit_price_minor,line_total_minor,cost_minor,cost_evidence_id,recorded_at)
        VALUES($1,$2,$3,$4,$5,'one','ORACLE','Synthetic oracle',$6,100000,$7,$8,$9,$10)`,
      [revisionId,merchant,store,id,number,revision.quantity,amount,revision.quantity*60000,`oracle-cost-${revisionId}`,at]);
    }
    let chargeObligation = "";
    for (const event of order.paymentEvents) {
      const eventRevision = event.kind === "charge" ? originalRevision : currentRevision;
      const eventId = randomUUID(), obligation = event.kind === "charge" ? randomUUID() : chargeObligation;
      if (!obligation) throw Error("Oracle negative payment requires an earlier charge");
      if (event.kind === "charge") {
        chargeObligation = obligation;
        await client.query(`INSERT INTO app.commercial_obligations
          (id,merchant_id,store_id,order_id,commercial_revision_id,obligation_kind,currency_code,minor_unit_exponent,amount_minor,idempotency_key,source_type,source_id,source_occurred_at)
          VALUES($1::uuid,$2,$3,$4,$5,'order_charge','VND',0,$6,$1::text,'synthetic',$1::text,$7)`,
        [obligation,merchant,store,id,eventRevision,event.amountMinor,event.sourceOccurredAt]);
      }
      const evidence = event.kind !== "charge" ? "negative_collection_confirmed" : event.method === "cash" ? "cash_receipt" : "manual_verified";
      await client.query(`INSERT INTO app.payment_events
        (id,merchant_id,store_id,order_id,commercial_revision_id,kind,status,method,evidence_type,evidence_fingerprint,currency_code,minor_unit_exponent,amount_minor,idempotency_key,source_type,source_id,source_occurred_at,recorded_at)
        VALUES($1::uuid,$2,$3,$4,$5,$6,'posted',$7,$8,$9,'VND',0,$10,$1::text,'synthetic',$1::text,$11,$12)`,
      [eventId,merchant,store,id,eventRevision,event.kind,event.method,evidence,"a".repeat(64),event.amountMinor,event.sourceOccurredAt,event.recordedAt]);
      await client.query(`INSERT INTO app.payment_event_evidence
        (payment_event_id,merchant_id,store_id,evidence_type,source_system,source_reference,verification_status,evidence_fingerprint,source_occurred_at)
        VALUES($1::uuid,$2,$3,$4,'synthetic',$1::text,'verified',$5,$6)`, [eventId,merchant,store,evidence,"a".repeat(64),event.sourceOccurredAt]);
      await client.query(`INSERT INTO app.payment_event_allocations
        (merchant_id,store_id,obligation_id,payment_event_id,allocation_kind,currency_code,minor_unit_exponent,amount_minor,idempotency_key,allocated_at)
        VALUES($1,$2,$3,$4::uuid,$5,'VND',0,$6,$4::text,$7)`, [merchant,store,obligation,eventId,event.kind === "charge" ? "collection" : event.kind,event.amountMinor,event.sourceOccurredAt]);
      if (event.kind === "charge") await client.query(`INSERT INTO app.payment_event_component_allocations
        (payment_event_id,commercial_revision_id,merchant_id,store_id,currency_code,minor_unit_exponent,tax_mode,merchandise_gross_minor,discount_minor,merchandise_net_minor,shipping_minor,merchandise_vat_minor,shipping_vat_minor,vat_minor,unclassified_minor,total_minor)
        VALUES($1,$2,$3,$4,'VND',0,'exclusive',$5,0,$5,0,0,0,0,0,$5)`, [eventId,eventRevision,merchant,store,event.amountMinor]);
    }
    if (order.plannedPaymentMethod) await client.query(`INSERT INTO app.payment_entries
      (order_id,merchant_id,store_id,direction,method,amount,currency_code,status,created_by,created_at)
      VALUES($1,$2,$3,'charge',$4,100000,'vnd','pending','synthetic',$5)`, [id,merchant,store,order.plannedPaymentMethod,order.createdAt]);
    if (order.refundPayableAsOfMinor) {
      const payable = randomUUID();
      await client.query(`INSERT INTO app.customer_refund_payables
        (id,merchant_id,store_id,order_id,commercial_revision_id,payable_kind,currency_code,minor_unit_exponent,amount_minor,idempotency_key,source_type,source_id,source_occurred_at,recorded_at)
        VALUES($1::uuid,$2,$3,$4,$5,'order_cancellation','VND',0,$6,$1::text,'order_cancellation',$4,'2026-10-18T05:00:00Z','2026-10-18T05:00:01Z')`, [payable,merchant,store,id,currentRevision,order.refundPayableAsOfMinor]);
      await client.query(`INSERT INTO app.customer_refund_payable_events
        (payable_id,merchant_id,store_id,order_id,event_kind,currency_code,minor_unit_exponent,amount_minor,idempotency_key,source_type,source_id,source_occurred_at,recorded_at)
        VALUES($1::uuid,$2,$3,$4,'open','VND',0,$5,$1::text,'order_cancellation',$4,'2026-10-18T05:00:00Z','2026-10-18T05:00:01Z')`, [payable,merchant,store,id,order.refundPayableAsOfMinor]);
    }
  }
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  return { scoped };
}
