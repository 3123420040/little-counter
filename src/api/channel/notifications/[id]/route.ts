import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { markTelegramNotificationFailed, markTelegramNotificationSent } from "@medusa-snus/application";
import { body, headers, rateLimit, route } from "../../../../lib/route-utils";

interface NotificationUpdateBody {
  status?: "sent" | "failed";
  error?: string;
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "default");
    const { id } = req.params as { id: string };
    const input = body<NotificationUpdateBody>(req);
    if (input.status === "sent") return markTelegramNotificationSent(headers(req), id);
    return markTelegramNotificationFailed(headers(req), id, input.error || "Telegram dispatch failed");
  });
}
