import { getPlatformStoreDetail } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { actorWithPlatformReadAccess, query, route } from "../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithPlatformReadAccess(req);
    return getPlatformStoreDetail(scope, String(req.params?.storeId || ""),Number(query(req).auditOffset||0));
  });
}
