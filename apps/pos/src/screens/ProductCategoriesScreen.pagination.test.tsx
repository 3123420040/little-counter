// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { renderTestUi, click, type TestRender } from "../test/reactTestHarness";

const source = vi.hoisted(() => ({ count: 21, loadingOffset: -1, requestedOffsets: [] as number[] }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ operator: { role: "owner" } }) }));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../components/ExportTemplateActions", () => ({ ExportTemplateActions: () => null }));
vi.mock("../components/ImportDialog", () => ({ ImportDialog: () => null }));
vi.mock("../hooks/useProductCategories", () => ({
  useProductCategories: (filters: { limit: number; offset: number }) => {
    if (filters.limit === 20) source.requestedOffsets.push(filters.offset);
    return {
      data: filters.offset === source.loadingOffset ? undefined : {
        count: source.count,
        product_categories: Array.from({ length: Math.max(0, Math.min(filters.limit, source.count - filters.offset)) }, (_, i) => ({
          id: `category-${filters.offset + i + 1}`, name: `Audit category ${filters.offset + i + 1}`, handle: `audit-${filters.offset + i + 1}`, isActive: true, productCount: 0,
        })),
      },
      isLoading: filters.offset === source.loadingOffset, error: null, refetch: vi.fn(),
    };
  },
  useCreateProductCategory: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateProductCategory: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteProductCategory: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
import ProductCategoriesScreen from "./ProductCategoriesScreen";
let mounted: TestRender | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; source.count = 21; source.loadingOffset = -1; source.requestedOffsets = []; });

it("contract challenge: deleting final row on server page 2 refetches valid page 1", () => {
  mounted = renderTestUi(<ProductCategoriesScreen />);
  click(mounted.container.querySelector('button[aria-label="Trang tiếp"]')!);
  expect(mounted.container.textContent).toContain("Audit category 21");
  source.count = 20;
  mounted.rerender(<ProductCategoriesScreen />);
  expect(source.requestedOffsets.at(-1)).toBe(0);
  expect(mounted.container.textContent).toContain("Audit category 1");
});

it("does not clamp a pending page before its count arrives", () => {
  mounted = renderTestUi(<ProductCategoriesScreen />);
  source.loadingOffset = 20;
  click(mounted.container.querySelector('button[aria-label="Trang tiếp"]')!);
  expect(source.requestedOffsets.at(-1)).toBe(20);
  expect(mounted.container.querySelectorAll("tbody tr")).toHaveLength(0);
  source.loadingOffset = -1;
  mounted.rerender(<ProductCategoriesScreen />);
  expect(source.requestedOffsets.at(-1)).toBe(20);
  expect(mounted.container.textContent).toContain("Audit category 21");
});
