// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { click, renderTestUi, type TestRender } from "../test/reactTestHarness";

const source = vi.hoisted(() => ({
  count: 21,
  loadingOffset: -1,
  requestedOffsets: [] as number[],
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ operator: { role: "owner" } }) }));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../components/ExportTemplateActions", () => ({ ExportTemplateActions: () => null }));
vi.mock("../components/ImportDialog", () => ({ ImportDialog: () => null }));
vi.mock("../api/endpoints", () => ({
  fetchLatestProductResearch: vi.fn(),
  fetchProductTag: vi.fn(),
  fetchSyncBootstrap: vi.fn(() => new Promise(() => undefined)),
  runProductResearch: vi.fn(),
}));
vi.mock("../hooks/useAdminProducts", () => ({
  useAdminProducts: (filters: { limit: number; offset: number }) => {
    source.requestedOffsets.push(filters.offset);
    const isLoading = filters.offset === source.loadingOffset;
    return {
      data: isLoading ? undefined : {
        count: source.count,
        limit: filters.limit,
        offset: filters.offset,
        metrics: {
          total: source.count,
          published: source.count - 2,
          draft: 2,
          uncategorized: 1,
        },
        products: Array.from(
          { length: Math.max(0, Math.min(filters.limit, source.count - filters.offset)) },
          (_, index) => ({
            id: `product-${filters.offset + index + 1}`,
            title: `Audit product ${filters.offset + index + 1}`,
            status: "published",
            categories: [],
            variants: [{
              id: `variant-${filters.offset + index + 1}`,
              sku: `SKU-${filters.offset + index + 1}`,
              barcode: "",
              prices: [{ amount: 100_000 }],
              inventory_quantity: 0,
            }],
          }),
        ),
      },
      isLoading,
      error: null,
      refetch: vi.fn(),
    };
  },
  useCreateAdminProduct: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateAdminProduct: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../hooks/useProductCategories", () => ({
  useProductCategories: () => ({
    data: { product_categories: [] },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

import ProductsScreen from "./ProductsScreen";

let mounted: TestRender | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  source.count = 21;
  source.loadingOffset = -1;
  source.requestedOffsets = [];
});

it("uses the server count for pagination and server metrics instead of the visible page", () => {
  mounted = renderTestUi(<ProductsScreen />);

  expect(source.requestedOffsets.at(-1)).toBe(0);
  expect(mounted.container.textContent).toContain("19");
  expect(mounted.container.textContent).toContain("Audit product 20");

  click(mounted.container.querySelector('button[aria-label="Trang tiếp"]')!);

  expect(source.requestedOffsets.at(-1)).toBe(20);
  expect(mounted.container.textContent).toContain("Audit product 21");
  expect(mounted.container.textContent).not.toContain("Audit product 1");
});

it("does not clamp a pending server page before its count arrives", () => {
  mounted = renderTestUi(<ProductsScreen />);
  source.loadingOffset = 20;

  click(mounted.container.querySelector('button[aria-label="Trang tiếp"]')!);

  expect(source.requestedOffsets.at(-1)).toBe(20);
  expect(mounted.container.textContent).not.toContain("Audit product 21");

  source.loadingOffset = -1;
  mounted.rerender(<ProductsScreen />);

  expect(source.requestedOffsets.at(-1)).toBe(20);
  expect(mounted.container.textContent).toContain("Audit product 21");
});
