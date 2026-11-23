import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { handleProviderPaymentEvent, verifySepayWebhook } from "@medusa-snus/application";
import { body, headers, rateLimit, route } from "../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "checkout");
    const payload = body<Record<string, unknown>>(req);
    const event = verifySepayWebhook(headers(req), payload, rawBody(req));
    const result = await handleProviderPaymentEvent(event);
    return { success: true, result };
  });
}

function rawBody(req: MedusaRequest): string | undefined {
  const candidate = (req as unknown as { rawBody?: Buffer | string; bodyRaw?: Buffer | string }).rawBody
    ?? (req as unknown as { rawBody?: Buffer | string; bodyRaw?: Buffer | string }).bodyRaw;
  if (Buffer.isBuffer(candidate)) return candidate.toString("utf8");
  return typeof candidate === "string" ? candidate : undefined;
}
