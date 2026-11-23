export interface PackageComparisonRow {
  feature: string;
  basic?: boolean;
  plus?: boolean;
  aiFan?: boolean;
}

export const PACKAGE_PAYMENT_POLICY_COPY =
  "Giá đã bao gồm thuế. Gói chỉ thay đổi sau khi thanh toán được xác nhận thành công. Không hoàn tiền trong phiên bản 1.1.2.";

export const PACKAGE_COMPARISON_ROWS: PackageComparisonRow[] = [
  { feature: "POS bán hàng cơ bản", basic: true, plus: true, aiFan: true },
  { feature: "Kế toán cơ bản", basic: true, plus: true, aiFan: true },
  { feature: "Thanh toán SePay QR", basic: false, plus: true, aiFan: true },
  { feature: "Telegram bot", basic: false, plus: false, aiFan: true },
  { feature: "Nghiên cứu sản phẩm AI (Tavily)", basic: false, plus: true, aiFan: true },
  { feature: "Đặt hàng qua Telegram AI", basic: false, plus: false, aiFan: true },
  { feature: "Gợi ý bán chéo thông minh", basic: false, plus: true, aiFan: true },
  { feature: "Thanh toán crypto (NOWPayments)", basic: false, plus: true, aiFan: true },
  { feature: "Số cửa hàng tối đa", basic: true, plus: true, aiFan: true },
];
