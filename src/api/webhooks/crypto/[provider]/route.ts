import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { handleProviderPaymentEvent, PlatformError, verifyNowPaymentsWebhook } from "@medusa-snus/application";
import { body, headers, rateLimit, route } from "../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "checkout");
    const provider = String(req.params?.provider || "").toLowerCase();
    if (provider !== "nowpayments") {
      throw new PlatformError("unsupported_crypto_provider", "Only nowpayments crypto webhook is implemented in 1.1.2", 400);
    }
    const payload = body<Record<string, unknown>>(req);
    const event = verifyNowPaymentsWebhook(headers(req), payload);
    const result = await handleProviderPaymentEvent(event);
    return { success: true, result };
  });
}
