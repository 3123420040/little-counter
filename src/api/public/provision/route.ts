import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { route, body, rateLimit } from "../../../lib/route-utils";
import { provisionSignupTenant } from "@medusa-snus/application";
import { PlatformError } from "@medusa-snus/application";

interface ProvisionBody {
  token?: string;
  merchantName?: string;
  storeName?: string;
  timezone?: string;
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "auth");
    const input = body<ProvisionBody>(req);
    if (!input.token) throw new PlatformError("validation_error", "Verification token is required.", 400);
    if (!input.merchantName || !input.storeName || !input.timezone) {
      throw new PlatformError("validation_error", "Merchant name, store name and timezone are required.", 400);
    }
    const result = await provisionSignupTenant({
      token: String(input.token),
      merchantName: String(input.merchantName),
      storeName: String(input.storeName),
      timezone: String(input.timezone),
    }, req.headers);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    return { data: result, statusCode: 201 };
  });
}
