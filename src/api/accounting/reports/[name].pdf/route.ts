import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import { getBalanceSheet, getCashFlow, getIncomeStatement, getTaxSummary, reportPdfBuffer, sendPlatformError } from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithReportScope, query } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { scope } = await actorWithReportScope(req, "staff", permissions.accountingRead);
    const { name } = req.params as { name: string };
    const q = query(req);
    const data = name === "balance-sheet"
      ? await getBalanceSheet(scope, q.asOf)
      : name === "tax-summary"
        ? await getTaxSummary(scope, q.from, q.to)
        : name === "cash-flow"
          ? await getCashFlow(scope, q.from, q.to)
          : await getIncomeStatement(scope, q.from, q.to);
    const pdf = await reportPdfBuffer(name, data.data);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${name}.pdf"`);
    res.status(200).send(pdf);
  } catch (err) {
    sendPlatformError(res as unknown as { status: (code: number) => { json: (body: unknown) => void } }, err);
  }
}
