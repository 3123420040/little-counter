import type { MedusaRequest, MedusaResponse } from "../../../../lib/http-types";
import {
  getEffectiveOrderFeatureCsvV5,
  sendPlatformError, PlatformError,
} from "@medusa-snus/application";
import { permissions } from "@medusa-snus/contracts";
import { actorWithOrderHistoryScope, query, queryValues } from "../../../../lib/route-utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { scope } = await actorWithOrderHistoryScope(req, "staff", permissions.ordersExport);
    const q = query(req);
    if (q.status && !["all", "completed", "other"].includes(q.status)) throw new PlatformError("validation_error", "Invalid export status", 400);
    if (q.grain && !["order", "effective_line"].includes(q.grain)) throw new PlatformError("validation_error", "Invalid export grain", 400);
    const response = await getEffectiveOrderFeatureCsvV5({
      scope,
      from: q.from || q.dateFrom || "",
      to: q.to || q.dateTo || "",
      ...(q.search ? { search: q.search } : {}),
      statusMode: q.status === "completed" || q.status === "other" ? q.status : "all",
      creatorOperatorIds: queryValues(req, "creatorOperatorId"),
      grain: q.grain === "effective_line" ? "effective_line" : "order",
      ...(q.batchSize ? { batchSize: Number(q.batchSize) } : {}),
    });
    for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
    res.status(response.statusCode).send(response.body);
  } catch (error) {
    sendPlatformError(
      res as unknown as { status: (code: number) => { json: (body: unknown) => void } },
      error,
    );
  }
}
