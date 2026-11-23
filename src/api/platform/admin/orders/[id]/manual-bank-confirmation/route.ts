import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import {
  assertOperatingMutationTarget,
  confirmInitialManualBankPaymentV1,
  getOrderMutationTarget,
} from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import {
  actorWithOperatingScopeMutation,
  body,
  headers,
  route,
} from "../../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const { actor, scope } = await actorWithOperatingScopeMutation(
      req,
      permissions.accountingWrite,
    );
    assertOperatingMutationTarget(scope, await getOrderMutationTarget(id), "Order");
    const result = await confirmInitialManualBankPaymentV1(
      headers(req),
      id,
      body(req),
      actor,
      scope,
    );
    res.status(result.statusCode);
    return result.response;
  });
}
