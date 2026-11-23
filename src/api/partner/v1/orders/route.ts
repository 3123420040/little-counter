import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { partnerHttpRead, partnerHttpBook } from "@medusa-snus/application/partner";
export async function GET(req:MedusaRequest,res:MedusaResponse){
  const result=await partnerHttpRead("orders",req);
  for(const [key,value] of Object.entries(result.headers))res.setHeader(key,value);
  res.status(result.status).json(result.body);
}
export async function POST(req:MedusaRequest,res:MedusaResponse){
  const result=await partnerHttpBook(req);
  for(const [key,value] of Object.entries(result.headers))res.setHeader(key,value);
  res.status(result.status).json(result.body);
}
