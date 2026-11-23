import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { InMemoryStoreAdapter } from "@medusa-snus/application";
import { assertLegacyAccountingPluginAllowed } from "../legacy-quarantine";
import { AccountingService } from "../services/accounting-service";
import { ReportService } from "../services/report-service";

/**
 * @deprecated Legacy in-memory accounting routes. Production accounting uses
 * `src/api/accounting/*` backed by `packages/application/src/services/accounting-service.ts`.
 */
export function registerAccountingRoutes(server: FastifyInstance, store: InMemoryStoreAdapter) {
  assertLegacyAccountingPluginAllowed();
  const svc = new AccountingService(store);

  // GET /accounting/accounts
  server.get("/accounting/accounts", async (_req: FastifyRequest, reply: FastifyReply) => {
    const accounts = await svc.getAccounts();
    return reply.send({ data: accounts });
  });

  // POST /accounting/accounts
  server.post("/accounting/accounts", async (req: FastifyRequest, reply: FastifyReply) => {
    const { code, name, type, parentId, description } = req.body as Record<string, unknown>;
    const account = await svc.createAccount({
      code: String(code), name: String(name), type: String(type) as import("@medusa-snus/contracts").AccountType,
      parentId: parentId as string | undefined, description: description as string | undefined,
    });
    return reply.status(201).send({ data: account });
  });

  // GET /accounting/journal-entries
  server.get("/accounting/journal-entries", async (req: FastifyRequest, reply: FastifyReply) => {
    const { dateFrom, dateTo, status } = req.query as Record<string, string>;
    const entries = svc.getEntries({ dateFrom, dateTo, status });
    return reply.send({ data: entries });
  });

  // POST /accounting/journal-entries
  server.post("/accounting/journal-entries", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown>;
    const entry = await svc.createJournalEntry({
      entryDate: String(body.entryDate),
      referenceType: body.referenceType as string | undefined,
      referenceId: body.referenceId as string | undefined,
      description: String(body.description),
      createdBy: String(body.createdBy || "unknown"),
      lines: (body.lines as Array<Record<string, unknown>> || []).map(l => ({
        accountCode: String(l.accountCode),
        debitAmount: Number(l.debitAmount) || 0,
        creditAmount: Number(l.creditAmount) || 0,
        description: l.description as string | undefined,
      })),
    });
    return reply.status(201).send({ data: entry });
  });

  // POST /accounting/journal-entries/:id/post
  server.post("/accounting/journal-entries/:id/post", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const entry = await svc.postEntry(id);
    return reply.send({ data: entry });
  });

  // POST /accounting/journal-entries/:id/void
  server.post("/accounting/journal-entries/:id/void", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const entry = await svc.voidEntry(id);
    return reply.send({ data: entry });
  });

  // GET /accounting/reports/income-statement
  server.get("/accounting/reports/income-statement", async (req: FastifyRequest, reply: FastifyReply) => {
    const { from, to } = req.query as { from: string; to: string };
    const stmt = svc.getIncomeStatement(from, to);
    return reply.send({ data: stmt });
  });

  // GET /accounting/reports/balance-sheet
  server.get("/accounting/reports/balance-sheet", async (req: FastifyRequest, reply: FastifyReply) => {
    const { asOf } = req.query as { asOf: string };
    const bs = svc.getBalanceSheet(asOf);
    return reply.send({ data: bs });
  });

  // GET /accounting/reports/tax-summary
  server.get("/accounting/reports/tax-summary", async (req: FastifyRequest, reply: FastifyReply) => {
    const { from, to } = req.query as { from: string; to: string };
    const tax = svc.getTaxSummary(from, to);
    return reply.send({ data: tax });
  });

  // GET /accounting/reports/income-statement/pdf
  server.get("/accounting/reports/income-statement/pdf", async (req: FastifyRequest, reply: FastifyReply) => {
    const { from, to } = req.query as { from: string; to: string };
    const reportSvc = new ReportService(svc);
    const html = reportSvc.generateIncomeStatementHtml(from, to);
    return reply.header("Content-Type", "text/html; charset=utf-8").send(html);
  });

  // GET /accounting/reports/balance-sheet/pdf
  server.get("/accounting/reports/balance-sheet/pdf", async (req: FastifyRequest, reply: FastifyReply) => {
    const { asOf } = req.query as { asOf: string };
    const reportSvc = new ReportService(svc);
    const html = reportSvc.generateBalanceSheetHtml(asOf);
    return reply.header("Content-Type", "text/html; charset=utf-8").send(html);
  });

  // GET /accounting/reports/tax-summary/pdf
  server.get("/accounting/reports/tax-summary/pdf", async (req: FastifyRequest, reply: FastifyReply) => {
    const { from, to } = req.query as { from: string; to: string };
    const reportSvc = new ReportService(svc);
    const html = reportSvc.generateTaxSummaryHtml(from, to);
    return reply.header("Content-Type", "text/html; charset=utf-8").send(html);
  });
}
