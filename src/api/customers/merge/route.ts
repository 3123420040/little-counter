import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { getCustomerMutationTarget, mergeCustomers } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetMutation, actorWithOperatingScopeMutation, body, headers, route } from "../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const input = body<{ primaryId?: string; duplicateId?: string }>(req);
    const merchantId = input.primaryId
      ? (await getCustomerMutationTarget(input.primaryId)).merchantId
      : (await actorWithOperatingScopeMutation(req, permissions.customerWrite)).scope.merchantId;
    const { actor: operator, scope } = await actorWithMerchantTargetMutation(req, permissions.customerWrite, merchantId);
    const result = await mergeCustomers(headers(req), input, operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
