import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { getDashboard } from "@medusa-snus/application";
import { actorWithFullDashboardReportScope, query, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    // Forward the resolved ReportScope to the dashboard service.
    const { scope } = await actorWithFullDashboardReportScope(req);
    const q = query(req);
    return getDashboard(scope, { date: q.date, from: q.from, to: q.to });
  });
}
