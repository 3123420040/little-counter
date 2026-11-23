import type { PoolClient } from "pg";
import type { PartnerOrder } from "@medusa-snus/contracts/partner-api";
import { readEffectiveOrdersV1 } from "../services/effective-order-projection-service";
import { decodePartnerCursor, encodePartnerCursor, type PartnerKeyring } from "./fingerprints";
import type { PartnerContext } from "./registry";
import { PartnerError } from "./errors";

interface OwnedOrder {
  id:string; core_order_id:string; external_order_id:string; created_at:Date; sort_time:string;
}
async function mapOwnedOrders(db:PoolClient,ctx:PartnerContext,rows:OwnedOrder[],asOf:string):Promise<PartnerOrder[]> {
  if(!rows.length)return [];
  try{
    const effective=await readEffectiveOrdersV1(db,{scope:{scopeKind:"report",merchantId:ctx.merchantId,storeIds:[ctx.storeId]},
      orderIds:rows.map(row=>row.core_order_id),currencyCode:"VND",asOf});
    const evidence=(await db.query(`SELECT o.core_order_id,
      greatest(o.created_at,coalesce((SELECT max(r.effective_at) FROM app.order_commercial_revisions r
        WHERE r.merchant_id=$1 AND r.store_id=$2 AND r.order_id=o.core_order_id AND r.effective_at<=$4),o.created_at),
        coalesce(max(e.recorded_at) FILTER (WHERE e.recorded_at<=$4),o.created_at)) AS updated_at,
      coalesce(sum(e.amount_minor) FILTER (WHERE e.kind='charge' AND e.status='posted' AND e.recorded_at<=$4
        AND e.evidence_type IN ('cash_receipt','manual_verified','provider_webhook_success')
        AND EXISTS(SELECT 1 FROM app.payment_event_evidence v WHERE v.payment_event_id=e.id
          AND v.verification_status='verified' AND v.evidence_type=e.evidence_type
          AND v.evidence_fingerprint=e.evidence_fingerprint AND v.source_occurred_at=e.source_occurred_at)),0) AS receipts
      FROM integration.partner_orders o LEFT JOIN app.payment_events e ON e.order_id=o.core_order_id AND e.merchant_id=o.merchant_id AND e.store_id=o.store_id
      WHERE o.merchant_id=$1 AND o.store_id=$2 AND o.id=ANY($3::text[]) AND o.integration_id=$5 GROUP BY o.id`,
    [ctx.merchantId,ctx.storeId,rows.map(row=>row.id),asOf,ctx.integrationId])).rows;
    return rows.map(row=>{
      const current=effective.find(item=>item.orderId===row.core_order_id);
      const receipt=evidence.find(item=>item.core_order_id===row.core_order_id);
      if(!current||!receipt)throw new PartnerError("effective_order_unavailable");
      const total=current.currentOrderGrossValueMinor;
      return {order_id:row.id,external_order_id:row.external_order_id,store_id:ctx.storeId,
        booking_status:current.commercialState==="cancelled"?"cancelled":"confirmed",
        collection_status:total>0&&Number(receipt.receipts)>=total?"confirmed":"unconfirmed",payment_method:"cod",currency:"VND",total,
        stock_deducted:true,created_at:new Date(row.created_at).toISOString(),updated_at:new Date(receipt.updated_at).toISOString()};
    });
  }catch(error){const failure=new PartnerError("effective_order_unavailable");failure.cause=error;throw failure;}
}
export async function readPartnerOrder(db:PoolClient,ctx:PartnerContext,orderId:string){
  if(!ctx.scopes.includes("orders:read"))throw new PartnerError("insufficient_scope");
  const rows=(await db.query<OwnedOrder>(`SELECT id,core_order_id,external_order_id,created_at
    FROM integration.partner_orders WHERE id=$1 AND integration_id=$2 AND merchant_id=$3 AND store_id=$4`,
  [orderId,ctx.integrationId,ctx.merchantId,ctx.storeId])).rows;
  if(!rows.length)throw new PartnerError("resource_not_found");
  return {data:(await mapOwnedOrders(db,ctx,rows,new Date().toISOString()))[0],meta:{request_id:ctx.requestId}};
}
export async function listPartnerOrders(db:PoolClient,ctx:PartnerContext,keys:PartnerKeyring,
  input:{limit:number;cursor?:string;external_order_id?:string;date_from?:string;date_to?:string}){
  if(!ctx.scopes.includes("orders:read"))throw new PartnerError("insufficient_scope");
  const filter={operation:"orders",external:input.external_order_id??null,from:input.date_from??null,to:input.date_to??null};
  const sort=input.cursor?decodePartnerCursor(keys,ctx,filter,input.cursor):[];
  if(sort.length&& (sort.length!==3||!Number.isFinite(Date.parse(sort[0]))||!Number.isFinite(Date.parse(sort[2]))))throw new PartnerError("invalid_cursor");
  const asOf=sort[2]??new Date().toISOString();
  const to=input.date_to??asOf;
  const from=input.date_from??new Date(Date.parse(to)-7*86400000).toISOString();
  const rows=(await db.query<OwnedOrder>(`SELECT id,core_order_id,external_order_id,created_at,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_time
    FROM integration.partner_orders WHERE integration_id=$1 AND merchant_id=$2 AND store_id=$3
      AND ($4::text IS NULL OR external_order_id=$4)
      AND ($4::text IS NOT NULL OR (created_at>=$5::timestamptz AND created_at<$6::timestamptz))
      AND created_at<=$7::timestamptz
      AND ($8::timestamptz IS NULL OR (created_at,id)<($8::timestamptz,$9::text))
    ORDER BY created_at DESC,id DESC LIMIT $10`,[ctx.integrationId,ctx.merchantId,ctx.storeId,input.external_order_id??null,
    from,to,asOf,sort[0]??null,sort[1]??null,input.limit+1])).rows;
  const page=rows.slice(0,input.limit);
  const last=page.at(-1);
  return {data:await mapOwnedOrders(db,ctx,page,asOf),page:{as_of:asOf,next_cursor:rows.length>input.limit&&last
    ?encodePartnerCursor(keys,ctx,filter,[last.sort_time,last.id,asOf]):null},meta:{request_id:ctx.requestId}};
}
