import type { MedusaRequest, MedusaResponse } from "../../lib/http-types";
import { getDashboard } from "@medusa-snus/application";
import { actorWithFullDashboardReportScope, query, route } from "../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    // Forward the resolved ReportScope to the dashboard service so the
    // aggregation is filtered to the active merchant (and stores).
    const { scope } = await actorWithFullDashboardReportScope(req);
    const q = query(req);
    const result = await getDashboard(scope, { date: q.date, from: q.from, to: q.to });
    return {
      orderCount: result.data.orderCount,
      totalRevenue: result.data.totalRevenue,
      totalProducts: result.data.products,
      lowStock: result.data.lowStock,
      from: result.data.from,
      to: result.data.to,
      daily: result.data.daily,
    };
  });
}
