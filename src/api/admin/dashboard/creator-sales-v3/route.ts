import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import {
  getCreatorSalesDashboardFeatureV3,
  PlatformError,
} from "@medusa-snus/application";
import {
  actorWithDashboardAudienceScope,
  query,
  queryValues,
  route,
} from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Dashboard-Contract", "dashboard.creator-sales.v3");
  await route(res, async () => {
    const { actor, scope, audience } = await actorWithDashboardAudienceScope(req);
    const q = query(req);
    const requestedCreatorIds = queryValues(req, "creatorOperatorId");
    const creatorOperatorIds = audience === "self"
      ? (() => {
          if (
            requestedCreatorIds.length > 0
            && (requestedCreatorIds.length !== 1 || requestedCreatorIds[0] !== actor.operatorId)
          ) {
            throw new PlatformError(
              "forbidden",
              "A self dashboard cannot select another creator or all creators",
              403,
            );
          }
          return [actor.operatorId];
        })()
      : requestedCreatorIds;
    const response = await getCreatorSalesDashboardFeatureV3({
      scope,
      from: q.from || q.date || "",
      to: q.to || q.date || "",
      creatorOperatorIds,
      audience,
      ...(audience === "self" ? { selfOperatorId: actor.operatorId } : {}),
    });
    return response;
  });
}
