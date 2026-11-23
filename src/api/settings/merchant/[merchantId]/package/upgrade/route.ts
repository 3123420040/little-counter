import type { PackageKey } from "@medusa-snus/contracts";
import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { PlatformError, requestOwnerPackageUpgrade } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithMerchantTargetMutation, body, route } from "../../../../../../lib/route-utils";

type UpgradeBody = {
  targetPackageKey?: PackageKey;
  idempotencyKey?: string;
};

function merchantId(req: MedusaRequest): string {
  return String(req.params?.merchantId || "");
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const target = merchantId(req);
    const { actor, scope } = await actorWithMerchantTargetMutation(req, permissions.subscriptionBill, target, "checkout");
    const input = body<UpgradeBody>(req);
    if (!input.targetPackageKey) {
      throw new PlatformError("invalid_target_package", "targetPackageKey is required", 400);
    }
    return requestOwnerPackageUpgrade(target, input.targetPackageKey, actor, scope, input.idempotencyKey);
  }, 201);
}
