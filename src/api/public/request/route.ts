import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { route, body, rateLimit } from "../../../lib/route-utils";
import { resolveTransactionalEmailProvider } from "@medusa-snus/application";
import { createSignupRequest } from "@medusa-snus/application";
import { PlatformError } from "@medusa-snus/application";

interface SignupBody {
  email?: string;
  password?: string;
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "auth");
    const body_ = body<SignupBody>(req);
    if (!body_.email || !body_.password) {
      throw new PlatformError("validation_error", "Email and password are required.", 400);
    }
    const ip = extractIp(req.headers);
    const provider = resolveTransactionalEmailProvider();
    const userAgent = Array.isArray(req.headers["user-agent"]) ? req.headers["user-agent"][0] : req.headers["user-agent"];
    const result = await createSignupRequest(
      { email: body_.email, password: body_.password, requestIp: ip, userAgent },
      provider,
    );
    if (result.status === "verification_delivery_failed") {
      return {
        data: { requestId: result.requestId, message: "Verification email could not be delivered. Please try again.", _hint: "resend" },
        statusCode: 202,
      };
    }
    return { data: result };
  });
}

function extractIp(headers: Record<string, string | string[] | undefined>): string | undefined {
  const fwd = headers["x-forwarded-for"] ?? headers["X-Forwarded-For"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  if (raw) return String(raw).split(",")[0].trim();
  return (headers["x-real-ip"] ?? headers["X-Real-IP"] ?? "") as string || undefined;
}
