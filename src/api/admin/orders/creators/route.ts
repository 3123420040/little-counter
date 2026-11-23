import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getOrderCreatorOptionsV1 } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOrderHistoryScope, route } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithOrderHistoryScope(req, "staff", permissions.ordersRead);
    const options = await getOrderCreatorOptionsV1(scope);
    return {
      schemaVersion: 1,
      creatorOptions: options,
    };
  });
}
