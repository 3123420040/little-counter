import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { assertNotReadOnlyImpersonation, PlatformError } from "@medusa-snus/application";
import { getMerchantIdForLegacyOrganization } from "../../../../../packages/application/src/services/subscription-service";
import {
  initiateNewSubscription,
  initiateUpgrade,
  initiateRenewal,
  initiateStoreAddon,
  quoteNowPaymentsBillingOrder,
} from "../../../../../packages/application/src/services/subscription-billing-service";
import { updateBillingOrderStatus } from "../../../../../packages/application/src/services/billing-order-service";
import { actorWithPermission, body, route } from "../../../../lib/route-utils";

type BillingOrderBody = {
  purpose: "new_subscription" | "upgrade" | "renewal" | "store_addon";
  targetPackageKey?: "plus" | "ai_fan";
  idempotencyKey?: string;
};

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const requestActor = await actorWithPermission(req, "owner", "subscription:bill", "checkout");
    await assertNotReadOnlyImpersonation(requestActor);
    const input = body<BillingOrderBody>(req);
    const merchantId = await getMerchantIdForLegacyOrganization("organizationId" in requestActor ? requestActor.organizationId : "org_default");
    const requestedBy = "operatorId" in requestActor ? requestActor.operatorId : "channel_actor";

    let firstPass;
    if (input.purpose === "new_subscription") {
      if (input.targetPackageKey !== "plus" && input.targetPackageKey !== "ai_fan") {
        throw new PlatformError("invalid_target_package", "targetPackageKey must be plus or ai_fan", 400);
      }
      firstPass = await initiateNewSubscription({ merchantId, targetPackageKey: input.targetPackageKey, requestedBy, idempotencyKey: input.idempotencyKey });
    } else if (input.purpose === "upgrade") {
      firstPass = await initiateUpgrade({ merchantId, requestedBy, idempotencyKey: input.idempotencyKey });
    } else if (input.purpose === "renewal") {
      firstPass = await initiateRenewal({ merchantId, requestedBy, idempotencyKey: input.idempotencyKey });
    } else if (input.purpose === "store_addon") {
      firstPass = await initiateStoreAddon({ merchantId, requestedBy, idempotencyKey: input.idempotencyKey });
    } else {
      throw new PlatformError("invalid_billing_purpose", "Unsupported billing purpose", 400);
    }

    const quote = await quoteNowPaymentsBillingOrder({
      amountVnd: firstPass.data.amount.amountVnd,
      orderId: firstPass.data.billingOrderId,
    });

    await updateBillingOrderStatus(firstPass.data.billingOrderId, {
      status: "waiting_payment",
      quote: {
        vndAmount: firstPass.data.amount.amountVnd,
        providerCurrency: quote.providerCurrency,
        providerNetwork: quote.providerNetwork,
        providerAmount: quote.providerAmount,
        providerPaymentId: quote.providerPaymentId,
        quoteExpiresAt: quote.quoteExpiresAt,
      },
    });

    return {
      data: {
        ...firstPass.data,
        status: "waiting_payment",
        providerQuote: {
          provider: "nowpayments",
          providerConfigPurpose: "platform_billing",
          businessPurpose: "platform_subscription",
          amountVnd: firstPass.data.amount.amountVnd,
          providerPaymentId: quote.providerPaymentId,
          providerCurrency: quote.providerCurrency,
          providerNetwork: quote.providerNetwork,
          providerAmount: quote.providerAmount,
          quoteExpiresAt: quote.quoteExpiresAt,
          providerFeeAbsorbedBy: "platform",
        },
      },
    };
  }, 201);
}
