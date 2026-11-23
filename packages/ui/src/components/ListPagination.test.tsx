// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ListPagination, loadedListPaginationMeta, localListPaginationMeta } from "./ListPagination";
import { click, renderTestUi } from "../../../../apps/pos/src/test/reactTestHarness";

describe("ListPagination", () => {
  it("clamps local pages and presents exact, loaded, and unknown totals truthfully", () => {
    expect(localListPaginationMeta(45, 99, 20)).toMatchObject({ page: 3, start: 41, end: 45, pageCount: 3 });
    const onPageChange = vi.fn();
    const mounted = renderTestUi(<ListPagination label="Khách hàng" rowNoun="khách hàng" meta={localListPaginationMeta(45, 2, 20)} onPageChange={onPageChange} />);
    expect(mounted.container.textContent).toContain("Hiển thị 21–40 / 45 khách hàng");
    click(Array.from(mounted.container.querySelectorAll("button")).find((button) => button.textContent === "Tiếp")!);
    expect(onPageChange).toHaveBeenCalledWith(3);
    mounted.unmount();
  });

  it("labels a capped upstream window as loaded rather than a global total", () => {
    const mounted = renderTestUi(
      <ListPagination
        label="Tồn kho"
        rowNoun="mặt hàng"
        meta={loadedListPaginationMeta(100, 1, 20)}
        onPageChange={vi.fn()}
      />,
    );

    expect(mounted.container.textContent).toContain("trong 100 mặt hàng đã tải");
    expect(mounted.container.textContent).not.toContain("/ 100 mặt hàng");
    mounted.unmount();
  });
});
