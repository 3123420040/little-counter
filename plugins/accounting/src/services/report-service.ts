import type { IncomeStatementResult, BalanceSheetResult } from "../models/account";
import { AccountingService } from "./accounting-service";

// ═══════════════════════════════════════════════════════
// Report Service — PDF generation + formatted reports
// Per FR-3.4 (Financial Reports)
// ═══════════════════════════════════════════════════════

export class ReportService {
  constructor(private accountingService: AccountingService) {}

  getIncomeStatement(from: string, to: string): IncomeStatementResult {
    return this.accountingService.getIncomeStatement(from, to);
  }

  getBalanceSheet(asOf: string): BalanceSheetResult {
    return this.accountingService.getBalanceSheet(asOf);
  }

  getTaxSummary(from: string, to: string): { outputVat: number; inputVat: number; vatPayable: number } {
    return this.accountingService.getTaxSummary(from, to);
  }

  /**
   * Generate HTML for PDF export (server-side rendering)
   * Print via headless browser or HTML→PDF library in production
   */
  generateIncomeStatementHtml(from: string, to: string): string {
    const stmt = this.getIncomeStatement(from, to);
    return `
<!DOCTYPE html>
<html lang="vi">
<head><meta charset="UTF-8"><title>Báo cáo KQKD</title>
<style>
  body { font-family: sans-serif; margin: 40px; font-size: 12px; }
  h1 { text-align: center; font-size: 18px; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th, td { border: 1px solid #000; padding: 8px; text-align: right; }
  th { background: #f0f0f0; text-align: center; }
  .text-left { text-align: left; }
  .total { font-weight: bold; border-top: 2px solid #000; }
  .header { text-align: center; margin-bottom: 30px; }
  .header p { margin: 2px 0; }
</style></head>
<body>
  <div class="header">
    <h1>KẾT QUẢ HOẠT ĐỘNG KINH DOANH</h1>
    <p>Từ ${from} đến ${to}</p>
    <p>Little Counter</p>
  </div>
  <table>
    <tr><th class="text-left" colspan="2">CHỈ TIÊU</th><th>SỐ TIỀN (VND)</th></tr>
    <tr><td class="text-left" colspan="2">Doanh thu bán hàng</td><td>${stmt.revenue.toLocaleString("vi-VN")}</td></tr>
    <tr><td class="text-left" colspan="2">Giá vốn hàng bán</td><td>${stmt.cogs.toLocaleString("vi-VN")}</td></tr>
    <tr class="total"><td class="text-left" colspan="2">Lợi nhuận gộp</td><td>${stmt.grossProfit.toLocaleString("vi-VN")}</td></tr>
    <tr><td class="text-left" colspan="2">Chi phí hoạt động</td><td>${stmt.operatingExpenses.toLocaleString("vi-VN")}</td></tr>
    <tr class="total"><td class="text-left" colspan="2">Lợi nhuận ròng</td><td>${stmt.netIncome.toLocaleString("vi-VN")}</td></tr>
  </table>
</body></html>`;
  }

  generateBalanceSheetHtml(asOf: string): string {
    const bs = this.getBalanceSheet(asOf);
    return `
<!DOCTYPE html>
<html lang="vi">
<head><meta charset="UTF-8"><title>Bảng cân đối kế toán</title>
<style>
  body { font-family: sans-serif; margin: 40px; font-size: 12px; }
  h1 { text-align: center; font-size: 18px; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th, td { border: 1px solid #000; padding: 8px; text-align: right; }
  th { background: #f0f0f0; text-align: center; }
  .text-left { text-align: left; }
  .total { font-weight: bold; border-top: 2px solid #000; }
  .header { text-align: center; margin-bottom: 30px; }
</style></head>
<body>
  <div class="header">
    <h1>BẢNG CÂN ĐỐI KẾ TOÁN</h1>
    <p>Tại ngày ${asOf}</p>
    <p>Little Counter</p>
  </div>
  <table>
    <tr><th class="text-left" colspan="2">TÀI SẢN</th><th>SỐ TIỀN (VND)</th></tr>
    <tr class="total"><td class="text-left" colspan="2">Tổng tài sản</td><td>${bs.totalAssets.toLocaleString("vi-VN")}</td></tr>
    <tr><th class="text-left" colspan="2">NGUỒN VỐN</th><th></th></tr>
    <tr class="total"><td class="text-left" colspan="2">Nợ phải trả</td><td>${bs.totalLiabilities.toLocaleString("vi-VN")}</td></tr>
    <tr class="total"><td class="text-left" colspan="2">Vốn chủ sở hữu</td><td>${bs.totalEquity.toLocaleString("vi-VN")}</td></tr>
  </table>
</body></html>`;
  }

  /**
   * Generate Vietnam VAT tax report HTML

   */
  generateTaxSummaryHtml(from: string, to: string): string {
    const tax = this.getTaxSummary(from, to);
    return `
<!DOCTYPE html>
<html lang="vi">
<head><meta charset="UTF-8"><title>Tờ khai thuế GTGT</title>
<style>
  body { font-family: sans-serif; margin: 40px; font-size: 12px; }
  h1 { text-align: center; font-size: 18px; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th, td { border: 1px solid #000; padding: 8px; text-align: right; }
  th { background: #f0f0f0; text-align: center; }
  .text-left { text-align: left; }
  .total { font-weight: bold; }
  .header { text-align: center; margin-bottom: 30px; }
</style></head>
<body>
  <div class="header">
    <h1>TỜ KHAI THUẾ GIÁ TRỊ GIA TĂNG</h1>
    <p>Kỳ tính thuế: ${from} đến ${to}</p>
  </div>
  <table>
    <tr><th class="text-left" colspan="2">CHỈ TIÊU</th><th>SỐ TIỀN (VND)</th></tr>
    <tr><td class="text-left" colspan="2">Thuế GTGT đầu ra</td><td>${tax.outputVat.toLocaleString("vi-VN")}</td></tr>
    <tr><td class="text-left" colspan="2">Thuế GTGT đầu vào được khấu trừ</td><td>${tax.inputVat.toLocaleString("vi-VN")}</td></tr>
    <tr class="total"><td class="text-left" colspan="2">Thuế GTGT phải nộp</td><td>${tax.vatPayable.toLocaleString("vi-VN")}</td></tr>
  </table>
</body></html>`;
  }
}
