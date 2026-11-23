import type { MedusaRequest, MedusaResponse } from "../../../../../../../lib/http-types";
import { resolvePublicScanGoProduct } from "@medusa-snus/application";
import { rateLimit, route } from "../../../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "default");
    const { merchantSlug, storeSlug, qrSlug } = req.params as Record<string, string | undefined>;
    return resolvePublicScanGoProduct({ merchantSlug, storeSlug, qrSlug });
  });
}
