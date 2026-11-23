import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getIncomeStatement } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithReportScope, query, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithReportScope(req, "staff", permissions.accountingRead);
    const q = query(req);
    return getIncomeStatement(scope, q.from, q.to);
  });
}
