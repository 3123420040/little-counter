import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getEffectiveOrderFeatureReceiptTextV1, sendPlatformError } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOrderHistoryScope } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { scope } = await actorWithOrderHistoryScope(req, "staff", permissions.ordersRead);
    const { id } = req.params as { id: string };
    const text = await getEffectiveOrderFeatureReceiptTextV1({
      scope,
      orderId: id,
    });
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="${id}-effective-receipt.txt"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).send(text);
  } catch (error) {
    sendPlatformError(res as never, error);
  }
}
