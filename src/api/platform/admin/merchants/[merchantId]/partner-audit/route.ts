import { randomUUID } from "node:crypto";
import { permissions } from "@medusa-snus/contracts";
import { exportPartnerAudit } from "@medusa-snus/application/partner-audit";
import type { MedusaRequest,MedusaResponse } from "../../../../../../lib/http-types";
import { actorWithMerchantTargetAccess,route } from "../../../../../../lib/route-utils";

export async function POST(req:MedusaRequest,res:MedusaResponse){
  const requestId=`req_${randomUUID()}`;
  res.setHeader("X-Request-Id",requestId);res.setHeader("Cache-Control","no-store");
  await route(res,async()=>{
    const {actor,scope}=await actorWithMerchantTargetAccess(req,permissions.accountingRead,String(req.params?.merchantId??""));
    return exportPartnerAudit(actor,scope,req.body,requestId);
  });
}
