import { listPlatformMcpConnections, createPlatformMcpConnection } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../../../../lib/http-types";
import { actorWithPlatformReadAccess, actorWithPlatformMutation, body, headers, query, route } from "../../../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  await route(res, async () => {
    const { actor } = await actorWithPlatformReadAccess(req);
    return listPlatformMcpConnections(actor, String(req.params?.merchantId || ""), query(req));
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  await route(res, async () => {
    const { actor } = await actorWithPlatformMutation(req);
    return createPlatformMcpConnection(actor, String(req.params?.merchantId || ""), body(req), headers(req));
  });
}
