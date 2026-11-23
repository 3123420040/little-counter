import { randomUUID } from "node:crypto";
import { permissions } from "@medusa-snus/contracts";
import { readPartnerStaffContact } from "@medusa-snus/application/partner-contact";
import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { actorWithOperatingScopeAccess, route } from "../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const requestId = `req_${randomUUID()}`;
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("Cache-Control", "no-store");
  await route(res, async () => {
    const { actor, scope } = await actorWithOperatingScopeAccess(req, permissions.partnerContactRead);
    return readPartnerStaffContact(actor, scope, String(req.params?.id ?? ""), requestId);
  });
}
