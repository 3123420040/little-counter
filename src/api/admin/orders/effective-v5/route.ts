import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getEffectiveOrderFeaturePageV5, PlatformError } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOrderHistoryScope, query, queryValues, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithOrderHistoryScope(req, "staff", permissions.ordersRead);
    const q = query(req);
    if (q.status && !["all", "completed", "other"].includes(q.status)) throw new PlatformError("validation_error", "Order status filter is invalid", 400);
    const response = await getEffectiveOrderFeaturePageV5({
      scope, from: q.from || q.dateFrom || "", to: q.to || q.dateTo || "",
      ...(q.search ? { search: q.search } : {}),
      statusMode: q.status === "completed" || q.status === "other" ? q.status : "all",
      creatorOperatorIds: queryValues(req, "creatorOperatorId"),
      ...(q.limit ? { limit: Number(q.limit) } : {}), ...(q.cursor ? { cursor: q.cursor } : {}),
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
    });
    for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
    return { statusCode: response.statusCode, ...response.body };
  });
}
