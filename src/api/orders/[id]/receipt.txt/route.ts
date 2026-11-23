import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getReceiptText, sendPlatformError } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOrderHistoryScope } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { scope } = await actorWithOrderHistoryScope(req, "staff", permissions.ordersRead);
    const { id } = req.params as { id: string };
    const text = await getReceiptText(id, scope);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="${id}-receipt.txt"`);
    res.status(200).send(text);
  } catch (err) {
    sendPlatformError(res as unknown as { status: (code: number) => { json: (body: unknown) => void } }, err);
  }
}
