import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { partnerHttpRead } from "@medusa-snus/application/partner";
export async function GET(req:MedusaRequest,res:MedusaResponse){
  const result=await partnerHttpRead("orderDetail",req);
  for(const [key,value] of Object.entries(result.headers))res.setHeader(key,value);
  res.status(result.status).json(result.body);
}
