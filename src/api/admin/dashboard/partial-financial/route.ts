import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getPartialFinancialFeatureDashboardV1 } from "@medusa-snus/application";
import { actorWithFullDashboardReportScope, query, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithFullDashboardReportScope(req);
    const q = query(req);
    const response = await getPartialFinancialFeatureDashboardV1({
      scope,
      from: q.from || q.date || "",
      to: q.to || q.date || "",
    });
    for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
    return { statusCode: response.statusCode, ...response.body };
  });
}
