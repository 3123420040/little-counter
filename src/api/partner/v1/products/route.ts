import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { partnerHttpRead } from "@medusa-snus/application/partner";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const result = await partnerHttpRead("products", req);
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  res.status(result.status).json(result.body);
}
