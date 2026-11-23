import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { loginOperator } from "@medusa-snus/application";
import { body, headers, rateLimit, route } from "../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, () => {
    const input = body<{ operatorId?: string; password?: string }>(req);
    rateLimit(req, "auth", { kind: "account", id: input.operatorId || "unknown" });
    return loginOperator(input, headers(req));
  });
}
