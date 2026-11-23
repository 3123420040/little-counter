import { describe, expect, it } from "vitest";
import { PACKAGE_COMPARISON_ROWS, PACKAGE_PAYMENT_POLICY_COPY } from "./package-comparison";

function row(feature: string) {
  const match = PACKAGE_COMPARISON_ROWS.find((item) => item.feature === feature);
  if (!match) throw new Error(`Missing package comparison row: ${feature}`);
  return match;
}

describe("package comparison table", () => {
  it("matches the 1.1.2 commercial package catalog for paid retail features", () => {
    expect(row("POS bán hàng cơ bản")).toMatchObject({ basic: true, plus: true, aiFan: true });
    expect(row("Kế toán cơ bản")).toMatchObject({ basic: true, plus: true, aiFan: true });
    expect(row("Thanh toán SePay QR")).toMatchObject({ basic: false, plus: true, aiFan: true });
    expect(row("Thanh toán crypto (NOWPayments)")).toMatchObject({ basic: false, plus: true, aiFan: true });
    expect(row("Gợi ý bán chéo thông minh")).toMatchObject({ basic: false, plus: true, aiFan: true });
    expect(row("Nghiên cứu sản phẩm AI (Tavily)")).toMatchObject({ basic: false, plus: true, aiFan: true });
    expect(row("Telegram bot")).toMatchObject({ basic: false, plus: false, aiFan: true });
    expect(row("Đặt hàng qua Telegram AI")).toMatchObject({ basic: false, plus: false, aiFan: true });
  });

  it("renders the payment policy without template placeholders", () => {
    expect(PACKAGE_PAYMENT_POLICY_COPY).toContain("phiên bản 1.1.2");
    expect(PACKAGE_PAYMENT_POLICY_COPY).not.toMatch(/[{}]/);
  });
});
