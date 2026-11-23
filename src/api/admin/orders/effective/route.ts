import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getEffectiveOrderFeaturePageV2 } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOrderHistoryScope, query, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithOrderHistoryScope(req, "staff", permissions.ordersRead);
    const q = query(req);
    const response = await getEffectiveOrderFeaturePageV2({
      scope,
      from: q.from || q.dateFrom || "",
      to: q.to || q.dateTo || "",
      ...(q.search ? { search: q.search } : {}),
      statusMode: q.status === "completed" || q.status === "other" ? q.status : "all",
      ...(q.limit ? { limit: Number(q.limit) } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
    });
    for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
    return { statusCode: response.statusCode, ...response.body };
  });
}
