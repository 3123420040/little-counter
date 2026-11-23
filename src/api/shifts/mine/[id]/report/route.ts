import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { getMyShiftReport } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithReadableReportScopeAccess, route } from "../../../../../lib/route-utils";

function shiftId(req: MedusaRequest): string {
  return String(req.params?.id || "");
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor, scope } = await actorWithReadableReportScopeAccess(req, permissions.shiftRead);
    return getMyShiftReport(shiftId(req), actor, scope);
  });
}
