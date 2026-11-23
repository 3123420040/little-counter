import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { route, body, rateLimit } from "../../../lib/route-utils";
import { resolveTransactionalEmailProvider, resendVerificationEmail } from "@medusa-snus/application";
import { PlatformError } from "@medusa-snus/application";

interface ResendBody { email?: string }

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "auth");
    const { email } = body<ResendBody>(req);
    if (!email) throw new PlatformError("validation_error", "Email is required.", 400);
    const provider = resolveTransactionalEmailProvider();
    const result = await resendVerificationEmail(String(email), provider);
    return { data: result };
  });
}
