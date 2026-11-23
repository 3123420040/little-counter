import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { createCustomer, listCustomers } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetMutation, actorWithOperatingScopeMutation, actorWithMerchantTargetAccess, body, headers, merchantTargetIdFromHeaders, query, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const merchantId = merchantTargetIdFromHeaders(req);
    const { scope } = await actorWithMerchantTargetAccess(req, permissions.customerRead, merchantId);
    return listCustomers({ ...query(req), merchantId: scope.merchantId });
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const operating = await actorWithOperatingScopeMutation(req, permissions.customerWrite);
    const { actor: operator, scope } = await actorWithMerchantTargetMutation(req, permissions.customerWrite, operating.scope.merchantId);
    const result = await createCustomer(headers(req), body(req), operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
