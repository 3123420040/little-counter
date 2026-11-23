import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { PlatformError } from "@medusa-snus/application";
import { platformWebhookDispatcher } from "../../../../packages/application/src/services/platform-subscription-nowpayments-adapter";
import { body, headers, route } from "../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const payload = body<Record<string, unknown>>(req);
    try {
      await platformWebhookDispatcher.dispatch({
        routeId: "platform-nowpayments-webhook",
        provider: "nowpayments",
        businessPurpose: "platform_subscription",
        providerConfigPurpose: "platform_billing",
        headers: headers(req),
        payload,
      });
    } catch (err) {
      if (err instanceof PlatformError && (err.code === "webhook_unauthorized" || err.code === "provider_config_missing")) {
        throw err;
      }
      return { success: true, status: "acknowledged" };
    }
    return { success: true, status: "acknowledged" };
  });
}
