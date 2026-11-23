import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getEffectiveOrderFeatureReceiptPdfV1, sendPlatformError } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOrderHistoryScope } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { scope } = await actorWithOrderHistoryScope(req, "staff", permissions.ordersRead);
    const { id } = req.params as { id: string };
    const pdf = await getEffectiveOrderFeatureReceiptPdfV1({
      scope,
      orderId: id,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${id}-effective-receipt.pdf"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).send(pdf);
  } catch (error) {
    sendPlatformError(res as never, error);
  }
}
