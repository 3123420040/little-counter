import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { listMyShifts } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithReadableReportScopeAccess, query, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor, scope } = await actorWithReadableReportScopeAccess(req, permissions.shiftRead);
    return listMyShifts(actor, scope, query(req));
  });
}
