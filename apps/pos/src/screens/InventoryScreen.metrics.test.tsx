// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { buttonByText, click, renderTestUi, type TestRender } from "../test/reactTestHarness";

const inventory = vi.hoisted(() => ({
  items: [
    { id: "above", sku: "ABOVE", title: "Above threshold", status: "published", reorder_level: 5, location_levels: [{ stocked_quantity: 6 }] },
    { id: "low", sku: "LOW", title: "Low stock", status: "published", reorder_level: 5, location_levels: [{ stocked_quantity: 5 }] },
    { id: "zero-published", sku: "ZERO-PUBLISHED", title: "Published zero", status: "published", reorder_level: 5, location_levels: [{ stocked_quantity: 0 }] },
    { id: "zero-draft", sku: "ZERO-DRAFT", title: "Draft zero", status: "draft", reorder_level: 5, location_levels: [{ stocked_quantity: 0 }] },
  ],
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock("../hooks/useInventory", () => ({
  useInventoryData: () => ({ data: inventory.items, isLoading: false, error: null, refetch: vi.fn() }),
  useInventoryAlerts: () => ({ data: { data: [] }, isLoading: false, error: null, refetch: vi.fn() }),
  useAdjustStock: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../hooks/useProductCategories", () => ({
  useProductCategories: () => ({ data: { product_categories: [] } }),
}));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../api/endpoints", () => ({ acknowledgeAiAlert: vi.fn() }));
vi.mock("../components/ExportTemplateActions", () => ({ ExportTemplateActions: () => null }));
vi.mock("../components/ImportDialog", () => ({ ImportDialog: () => null }));
vi.mock("../components/StaffScanDialog", () => ({ StaffScanDialog: () => null }));
vi.mock("../components/StockMovementLog", () => ({ StockMovementLog: () => null }));
vi.mock("../components/StockHistoryDrawer", () => ({ StockHistoryDrawer: () => null }));

import InventoryScreen from "./InventoryScreen";

let mounted: TestRender | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

it("labels inventory rows clearly and keeps all-row metrics stable after a table filter", () => {
  mounted = renderTestUi(<InventoryScreen />);

  expect(mounted.container.textContent).toContain("Dòng hàng của merchant");
  expect(mounted.container.textContent).toContain("Trên ngưỡng");
  expect(mounted.container.textContent).toContain("Tồn thấp");
  expect(mounted.container.textContent).toContain("gồm mọi trạng thái sản phẩm và không đổi khi lọc bảng");
  expect(mounted.container.textContent).toContain("dòng chưa có tồn tại kho này được tính là 0");
  expect(mounted.container.textContent).not.toContain("kết quả bị giới hạn");
  expect(Array.from(mounted.container.querySelectorAll("strong")).slice(0, 4).map((node) => node.textContent))
    .toEqual(["4", "1", "1", "2"]);

  click(buttonByText(mounted.container, "Hết hàng"));

  expect(mounted.container.textContent).toContain("Published zero");
  expect(mounted.container.textContent).toContain("Draft zero");
  expect(Array.from(mounted.container.querySelectorAll("strong")).slice(0, 4).map((node) => node.textContent))
    .toEqual(["4", "1", "1", "2"]);
});
