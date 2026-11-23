import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { reviewShift } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithReportScope, body, headers, route } from "../../../../lib/route-utils";

function shiftId(req: MedusaRequest): string {
  return String(req.params?.id || "");
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor, scope } = await actorWithReportScope(req, "staff", permissions.shiftReview);
    const result = await reviewShift(headers(req), shiftId(req), body(req), actor, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
