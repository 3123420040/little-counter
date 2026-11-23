import { getBuildInfoV2 } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { route } from "../../../lib/route-utils";

export async function GET(_req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  await route(res, async () => getBuildInfoV2("medusa"));
}
