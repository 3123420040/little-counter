import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { assertOperatingMutationTarget, getJournalEntryMutationTarget, postJournalEntry } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOperatingScopeMutation, headers, route } from "../../../../../lib/route-utils";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    const { id } = req.params as { id: string };
    const { actor: operator, scope } = await actorWithOperatingScopeMutation(req, permissions.accountingWrite);
    assertOperatingMutationTarget(scope, await getJournalEntryMutationTarget(id), "Journal entry");
    const result = await postJournalEntry(headers(req), id, operator, scope);
    res.status(result.statusCode);
    return result.response;
  });
}
