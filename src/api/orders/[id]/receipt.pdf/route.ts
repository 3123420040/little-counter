import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getReceiptPdfBuffer, sendPlatformError } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOrderHistoryScope } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { scope } = await actorWithOrderHistoryScope(req, "staff", permissions.ordersRead);
    const { id } = req.params as { id: string };
    const pdf = await getReceiptPdfBuffer(id, scope);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${id}-receipt.pdf"`);
    res.status(200).send(pdf);
  } catch (err) {
    sendPlatformError(res as unknown as { status: (code: number) => { json: (body: unknown) => void } }, err);
  }
}
