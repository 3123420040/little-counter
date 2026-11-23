import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getShiftReport } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithReportScope, route } from "../../../../lib/route-utils";

function shiftId(req: MedusaRequest): string {
  return String(req.params?.id || "");
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithReportScope(req, "staff", permissions.shiftReport);
    return getShiftReport(shiftId(req), scope);
  });
}
