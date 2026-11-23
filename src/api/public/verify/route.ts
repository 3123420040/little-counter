import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { route, body, rateLimit } from "../../../lib/route-utils";
import { verifySignupToken } from "@medusa-snus/application";
import { PlatformError } from "@medusa-snus/application";

interface VerifyBody { token?: string }

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "auth");
    const { token } = body<VerifyBody>(req);
    if (!token) throw new PlatformError("validation_error", "Verification token is required.", 400);
    const result = await verifySignupToken(String(token), req.headers);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    return { data: result };
  });
}
