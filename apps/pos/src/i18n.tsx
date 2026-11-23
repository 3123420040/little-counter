import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type Locale = "vi" | "en";

const messages = {
  vi: {
    // ── Navigation ──
    "nav.pos": "Bán hàng",
    "nav.shifts": "Ca làm",
    "nav.products": "Sản phẩm",
    "nav.categories": "Danh mục",
    "nav.inventory": "Tồn kho",
    "nav.purchaseOrders": "Đặt hàng",
    "nav.customers": "Khách hàng",
    "nav.orders": "Đơn hàng",
    "nav.telegramSales": "Telegram Sales",
    "nav.accounting": "Kế toán",
    "nav.vision": "Vision POS",
    "nav.ai": "AI Review",
    "nav.dashboard": "Tổng quan",
    "nav.audit": "Lịch sử",
    "nav.settings": "Cài đặt",
    "nav.account": "Tài khoản của tôi",
    "nav.platform": "Platform Admin",

    // ── Auth ──
    "auth.operatorId": "Tên đăng nhập / Username",
    "auth.password": "Mật khẩu",
    "auth.login": "Đăng nhập",
    "auth.loggingIn": "Đang đăng nhập...",
    "auth.forgotPassword": "Quên mật khẩu? Liên hệ quản lý.",
    "auth.invalidCredentials": "Sai thông tin đăng nhập",
    "auth.logout": "Đăng xuất",

    // ── POS ──
    "pos.searchPlaceholder": "Tìm SP, SKU, barcode...",
    "pos.emptyCart": "Chưa có sản phẩm. Chạm vào sản phẩm để thêm vào giỏ.",
    "pos.cart": "Giỏ hàng",
    "pos.customer": "Khách",
    "pos.tier": "Hạng",
    "pos.total": "Tổng",
    "pos.subtotal": "Tạm tính",
    "pos.payable": "Phải thu",
    "pos.checkout": "Thanh toán",
    "pos.offline": "Ngoại tuyến",
    "pos.offlineQueued": "đơn chờ đồng bộ",
    "pos.needsReview": "cần quản lý kiểm tra",
    "pos.savedOffline": "Đã lưu đơn offline. Hệ thống sẽ tự đồng bộ khi có mạng.",
    "pos.noProducts": "Chưa có sản phẩm",
    "pos.noSearchResults": "Không tìm thấy sản phẩm nào.",
    "pos.clearSearch": "Xóa tìm kiếm",
    "pos.saleConfirmed": "Đã thanh toán",
    "pos.selectingItem": "Đang chọn",
    "pos.payCash": "Tiền mặt",
    "pos.payTransfer": "Chuyển khoản",
    "pos.payCOD": "COD",
    "pos.discount": "Giảm giá",
    "pos.amountReceived": "Khách đưa",
    "pos.change": "Tiền thối",
    "pos.completeSale": "Hoàn tất đơn hàng",
    "pos.scanHint": "Quét mã vạch hoặc nhập tên SP...",

    // ── Inventory ──
    "inventory.title": "Tồn kho",
    "inventory.adjustStock": "Điều chỉnh tồn kho",
    "inventory.emptyProducts": "Chưa có sản phẩm trong kho.",
    "inventory.createFirstPO": "Tạo đơn nhập hàng đầu tiên",
    "inventory.aiAlerts": "Cảnh báo AI",
    "inventory.noAiAlerts": "Không có cảnh báo",
    "inventory.lowStockAlerts": "Cảnh báo tồn kho",
    "inventory.stockMovement": "Biến động gần đây",
    "inventory.selectProduct": "Chọn sản phẩm",
    "inventory.adjustQuantity": "Số lượng (+ thêm, − bớt)",
    "inventory.adjustReason": "Lý do",
    "inventory.damage": "Hư hỏng",
    "inventory.loss": "Thất thoát",
    "inventory.correction": "Điều chỉnh",
    "inventory.found": "Tìm thấy",

    // ── Product Categories ──
    "categories.title": "Danh mục sản phẩm",
    "categories.create": "Tạo danh mục",
    "categories.empty": "Chưa có danh mục.",

    // ── Products ──
    "products.title": "Sản phẩm",
    "products.create": "Tạo sản phẩm",
    "products.empty": "Chưa có sản phẩm.",

    // ── Purchase Orders ──
    "po.title": "Đơn đặt hàng",
    "po.create": "Tạo đơn",
    "po.createTitle": "Tạo đơn đặt hàng",
    "po.emptyOrders": "Chưa có đơn đặt hàng.",
    "po.createFirst": "Tạo đơn nhập đầu tiên",
    "po.receive": "Nhận hàng",
    "po.receiveTitle": "Nhận hàng",
    "po.received": "Đã nhận",
    "po.partiallyReceived": "Nhận một phần",
    "po.sent": "Đã gửi",
    "po.draft": "Nháp",
    "po.cancelled": "Đã hủy",
    "po.supplier": "Nhà cung cấp",
    "po.items": "Mặt hàng",
    "po.total": "Tổng",
    "po.orderedQty": "Đã đặt",
    "po.receiveQty": "Số lượng nhận",

    // ── Customers ──
    "customers.title": "Khách hàng",
    "customers.create": "Tạo khách hàng mới",
    "customers.empty": "Chưa có khách hàng.",
    "customers.createFirst": "Tạo khách hàng đầu tiên",
    "customers.searchPlaceholder": "Tìm SĐT, tên...",
    "customers.merge": "Gộp KH trùng",
    "customers.mergeConfirm": "Bạn có chắc muốn gộp 2 khách hàng? Hành động này không thể hoàn tác.",
    "customers.mergeGo": "Gộp",
    "customers.totalSpent": "Tổng chi",
    "customers.orders": "Đơn hàng",
    "customers.points": "Điểm",
    "customers.tier": "Hạng",
    "customers.tierProgress": "Tiến độ lên hạng",
    "customers.purchaseHistory": "Lịch sử mua hàng",
    "customers.pointsHistory": "Lịch sử điểm thưởng",

    // ── Orders ──
    "orders.title": "Đơn hàng",
    "orders.emptyToday": "Chưa có đơn hàng hôm nay",
    "orders.emptyAll": "Chưa có đơn hàng nào",
    "orders.walkIn": "Khách lẻ",
    "orders.detail": "Chi tiết đơn hàng",

    // ── Accounting ──
    "accounting.title": "Kế toán",
    "accounting.journal": "Sổ nhật ký",
    "accounting.reports": "Báo cáo",
    "accounting.createEntry": "Tạo bút toán",
    "accounting.editDraft": "Sửa bút toán draft",
    "accounting.emptyEntries": "Chưa có bút toán.",
    "accounting.autoCreated": "Bút toán sẽ tự động tạo khi bán hàng.",
    "accounting.postConfirm": "Ghi sổ bút toán này? Sau khi ghi sổ, không thể sửa.",
    "accounting.post": "Ghi sổ",
    "accounting.void": "Hủy bút toán",
    "accounting.incomeStatement": "Kết quả kinh doanh",
    "accounting.balanceSheet": "Bảng cân đối",
    "accounting.cashFlow": "Dòng tiền",
    "accounting.chartOfAccounts": "Hệ thống tài khoản",

    // ── AI Review ──
    "ai.title": "AI Review",
    "ai.queue": "Đề xuất AI",
    "ai.emptyQueue": "Chưa có đề xuất từ AI.",
    "ai.emptyExplanation": "Đề xuất sẽ xuất hiện khi hệ thống phát hiện cơ hội hoặc rủi ro.",
    "ai.draft": "AI đề xuất",
    "ai.confidence": "Độ tin cậy",
    "ai.riskLow": "Thấp",
    "ai.riskMedium": "Trung bình",
    "ai.riskHigh": "Cao",
    "ai.editContent": "Chỉnh sửa nội dung phản hồi",
    "ai.approve": "Phê duyệt",
    "ai.reject": "Từ chối",
    "ai.rejectSelf": "Tôi sẽ tự trả lời",
    "ai.rejectReason": "Lý do từ chối...",
    "ai.selectToReview": "Chọn một đề xuất để xem",

    // ── Dashboard ──
    "dashboard.title": "Tổng quan",
    "dashboard.loading": "Đang tải...",
    "dashboard.orders": "Đơn hàng",
    "dashboard.revenue": "Doanh thu",
    "dashboard.newCustomers": "Khách mới",
    "dashboard.products": "Sản phẩm",

    // ── Audit ──
    "audit.title": "Lịch sử thao tác",
    "audit.empty": "Chưa có bản ghi audit.",
    "audit.emptyExplanation": "Mọi thao tác quan trọng sẽ được ghi lại tại đây.",

    // ── Shared States ──
    "state.loading": "Đang tải...",
    "state.empty": "Không có dữ liệu",
    "state.retry": "Thử lại",
    "state.cancel": "Hủy",
    "state.confirm": "Xác nhận",
    "state.close": "Đóng",
    "state.edit": "Sửa",
    "state.delete": "Xóa",
    "state.noResults": "Không tìm thấy kết quả phù hợp",
    "state.staleData": "Dữ liệu hiển thị có thể cũ.",
  },

  en: {
    // ── Navigation ──
    "nav.pos": "POS",
    "nav.shifts": "Shifts",
    "nav.products": "Products",
    "nav.categories": "Categories",
    "nav.inventory": "Inventory",
    "nav.purchaseOrders": "Purchase Orders",
    "nav.customers": "Customers",
    "nav.orders": "Orders",
    "nav.telegramSales": "Telegram Sales",
    "nav.accounting": "Accounting",
    "nav.vision": "Vision POS",
    "nav.ai": "AI Review",
    "nav.dashboard": "Dashboard",
    "nav.audit": "Audit Log",
    "nav.settings": "Settings",
    "nav.account": "My Account",
    "nav.platform": "Platform Admin",

    // ── Auth ──
    "auth.operatorId": "Username",
    "auth.password": "Password",
    "auth.login": "Sign In",
    "auth.loggingIn": "Signing in...",
    "auth.forgotPassword": "Forgot password? Contact your manager.",
    "auth.invalidCredentials": "Invalid credentials",
    "auth.logout": "Sign Out",

    // ── POS ──
    "pos.searchPlaceholder": "Search product, SKU, barcode...",
    "pos.emptyCart": "Cart is empty. Tap a product to add it.",
    "pos.cart": "Cart",
    "pos.customer": "Customer",
    "pos.tier": "Tier",
    "pos.total": "Total",
    "pos.subtotal": "Subtotal",
    "pos.payable": "Payable",
    "pos.checkout": "Checkout",
    "pos.offline": "Offline",
    "pos.offlineQueued": "sales queued",
    "pos.needsReview": "need manager review",
    "pos.savedOffline": "Sale saved offline. It will sync automatically when the network is back.",
    "pos.noProducts": "No products",
    "pos.noSearchResults": "No products found.",
    "pos.clearSearch": "Clear search",
    "pos.saleConfirmed": "Sale completed",
    "pos.selectingItem": "Editing",
    "pos.payCash": "Cash",
    "pos.payTransfer": "Bank Transfer",
    "pos.payCOD": "COD",
    "pos.discount": "Discount",
    "pos.amountReceived": "Amount Received",
    "pos.change": "Change",
    "pos.completeSale": "Complete Sale",
    "pos.scanHint": "Scan barcode or type product name...",

    // ── Inventory ──
    "inventory.title": "Inventory",
    "inventory.adjustStock": "Adjust Stock",
    "inventory.emptyProducts": "No products in inventory.",
    "inventory.createFirstPO": "Create first purchase order",
    "inventory.aiAlerts": "AI Alerts",
    "inventory.noAiAlerts": "No alerts",
    "inventory.lowStockAlerts": "Low Stock Alerts",
    "inventory.stockMovement": "Recent Movements",
    "inventory.selectProduct": "Select product",
    "inventory.adjustQuantity": "Quantity (+ add, − remove)",
    "inventory.adjustReason": "Reason",
    "inventory.damage": "Damage",
    "inventory.loss": "Loss",
    "inventory.correction": "Correction",
    "inventory.found": "Found",

    // ── Product Categories ──
    "categories.title": "Product Categories",
    "categories.create": "Create Category",
    "categories.empty": "No categories yet.",

    // ── Products ──
    "products.title": "Products",
    "products.create": "Create Product",
    "products.empty": "No products yet.",

    // ── Purchase Orders ──
    "po.title": "Purchase Orders",
    "po.create": "Create Order",
    "po.createTitle": "Create Purchase Order",
    "po.emptyOrders": "No purchase orders.",
    "po.createFirst": "Create your first PO",
    "po.receive": "Receive",
    "po.receiveTitle": "Receive Items",
    "po.received": "Received",
    "po.partiallyReceived": "Partially Received",
    "po.sent": "Sent",
    "po.draft": "Draft",
    "po.cancelled": "Cancelled",
    "po.supplier": "Supplier",
    "po.items": "Items",
    "po.total": "Total",
    "po.orderedQty": "Ordered",
    "po.receiveQty": "Receive Qty",

    // ── Customers ──
    "customers.title": "Customers",
    "customers.create": "New Customer",
    "customers.empty": "No customers.",
    "customers.createFirst": "Create your first customer",
    "customers.searchPlaceholder": "Search phone, name...",
    "customers.merge": "Merge Duplicates",
    "customers.mergeConfirm": "Merge these two customers? This cannot be undone.",
    "customers.mergeGo": "Merge",
    "customers.totalSpent": "Total Spent",
    "customers.orders": "Orders",
    "customers.points": "Points",
    "customers.tier": "Tier",
    "customers.tierProgress": "Tier Progress",
    "customers.purchaseHistory": "Purchase History",
    "customers.pointsHistory": "Points History",

    // ── Orders ──
    "orders.title": "Orders",
    "orders.emptyToday": "No orders today",
    "orders.emptyAll": "No orders yet",
    "orders.walkIn": "Walk-in",
    "orders.detail": "Order Detail",

    // ── Accounting ──
    "accounting.title": "Accounting",
    "accounting.journal": "General Journal",
    "accounting.reports": "Reports",
    "accounting.createEntry": "Create Entry",
    "accounting.editDraft": "Edit Draft Entry",
    "accounting.emptyEntries": "No journal entries.",
    "accounting.autoCreated": "Entries are auto-created when sales occur.",
    "accounting.postConfirm": "Post this journal entry? Once posted, it cannot be edited.",
    "accounting.post": "Post",
    "accounting.void": "Void",
    "accounting.incomeStatement": "Income Statement",
    "accounting.balanceSheet": "Balance Sheet",
    "accounting.cashFlow": "Cash Flow",
    "accounting.chartOfAccounts": "Chart of Accounts",

    // ── AI Review ──
    "ai.title": "AI Review",
    "ai.queue": "AI Proposals",
    "ai.emptyQueue": "No AI proposals yet.",
    "ai.emptyExplanation": "Proposals appear when the system detects opportunities or risks.",
    "ai.draft": "AI Draft",
    "ai.confidence": "Confidence",
    "ai.riskLow": "Low",
    "ai.riskMedium": "Medium",
    "ai.riskHigh": "High",
    "ai.editContent": "Edit response content",
    "ai.approve": "Approve",
    "ai.reject": "Reject",
    "ai.rejectSelf": "I'll respond myself",
    "ai.rejectReason": "Rejection reason...",
    "ai.selectToReview": "Select a proposal to review",

    // ── Dashboard ──
    "dashboard.title": "Dashboard",
    "dashboard.loading": "Loading...",
    "dashboard.orders": "Orders",
    "dashboard.revenue": "Revenue",
    "dashboard.newCustomers": "New Customers",
    "dashboard.products": "Products",

    // ── Audit ──
    "audit.title": "Audit Log",
    "audit.empty": "No audit records.",
    "audit.emptyExplanation": "All important actions will be recorded here.",

    // ── Shared States ──
    "state.loading": "Loading...",
    "state.empty": "No data",
    "state.retry": "Retry",
    "state.cancel": "Cancel",
    "state.confirm": "Confirm",
    "state.close": "Close",
    "state.edit": "Edit",
    "state.delete": "Delete",
    "state.noResults": "No matching results",
    "state.staleData": "Displayed data may be stale.",
  },
} as const;

type MessageKey = keyof typeof messages.vi;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: "vi",
  setLocale: () => {},
  t: (key) => messages.vi[key],
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const saved = localStorage.getItem("snus_locale");
    return saved === "en" ? "en" : "vi";
  });

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale(nextLocale) {
      setLocaleState(nextLocale);
      localStorage.setItem("snus_locale", nextLocale);
    },
    t(key) {
      return messages[locale][key] || messages.vi[key];
    },
  }), [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
