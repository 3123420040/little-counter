import type { MedusaRequest, MedusaResponse } from "../../lib/http-types";
import { listAudit } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithReportScope, query, route } from "../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    // Audit log is tenant-owned; require explicit accounting:read permission
    // plus a ReportScope so the service filters by merchant_id.
    const { scope } = await actorWithReportScope(req, "staff", permissions.accountingRead);
    return listAudit(scope, query(req));
  });
}
