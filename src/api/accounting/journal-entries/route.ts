import type { MedusaRequest, MedusaResponse } from "../../../lib/http-types";
import { createJournalEntry, listJournalEntries } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, actorWithReportScope, body, headers, query, route } from "../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    // Journal entry list is tenant-owned; require a ReportScope so the
    // service can filter by merchant_id (and the optional store list).
    const { scope } = await actorWithReportScope(req, "staff", permissions.accountingRead);
    return listJournalEntries(scope, query(req));
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { actor: operator, scope } = await actorWithOperatingScopeMutation(req, permissions.accountingWrite);
    const result = await createJournalEntry(headers(req), body(req), operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
