import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { partnerHttpQuote } from "@medusa-snus/application/partner";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const result = await partnerHttpQuote(req);
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  res.status(result.status).json(result.body);
}
