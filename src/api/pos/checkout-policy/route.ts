import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { permissions } from "@medusa-snus/contracts";
import { readCheckoutSettlementPolicy } from "@medusa-snus/application";
import { actorWithOperatingScopeAccess, route } from "../../../lib/route-utils";

/**
 * Scoped, authenticated read of the store bank-transfer settlement policy
 * for the POS terminal. Read permission is the existing checkout capability
 * (`remote_order:create`), not settings-write; the response carries only the
 * resolved mode/version/acknowledgment version — never credentials or
 * account data.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { scope } = await actorWithOperatingScopeAccess(req, permissions.remoteOrderCreate);
    return readCheckoutSettlementPolicy(scope.merchantId, scope.storeId);
  });
}
