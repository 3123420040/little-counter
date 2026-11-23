// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PaginatedListFrame } from "./PaginatedListFrame";
import { OperationalTable } from "./OperationalTable";
import { paginateListItems, localListPaginationMeta, loadedListPaginationMeta } from "./ListPagination";
import { click, renderTestUi, type TestRender } from "../../../../apps/pos/src/test/reactTestHarness";
let mounted: TestRender | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; });

it.each([0, 1, 20, 21, 45])("navigates an entire %i-row table with the shared body and footer", (count) => {
  const onSelect = vi.fn();
  function Fixture() {
    const [page, setPage] = useState(1);
    const data = paginateListItems(Array.from({ length: count }, (_, id) => ({ id })), page, 20);
    return <PaginatedListFrame label="Records" rowNoun="records" meta={data} onPageChange={setPage}>
      <OperationalTable columns={["ID"]} rows={data.items.map(x => [String(x.id)])} onRowClick={(_, index) => onSelect(data.items[index!].id)} />
    </PaginatedListFrame>;
  }
  mounted = renderTestUi(<Fixture />);
  const seen: number[] = [];
  for (;;) {
    const body = mounted.container.querySelector('[data-list-body]')!;
    const rows = Array.from(body.querySelectorAll('tbody tr'));
    seen.push(...rows.map(row => Number(row.textContent)));
    if (rows[0]) click(rows[0] as HTMLElement);
    const next = mounted.container.querySelector<HTMLButtonElement>('[aria-label="Trang tiếp"]')!;
    expect(body.contains(next)).toBe(false);
    if (next.disabled) break;
    click(next);
  }
  expect(seen).toEqual(Array.from({ length: count }, (_, i) => i));
  if (count > 20) expect(onSelect).toHaveBeenCalledWith(20);
});

it("retains the list body and locks navigation while busy; composes loading and error states", () => {
  const change = vi.fn();
  const props = { label: "Records", rowNoun: "records", meta: localListPaginationMeta(45, 2, 20), onPageChange: change };
  mounted = renderTestUi(<PaginatedListFrame {...props} busy><p>Retained rows</p></PaginatedListFrame>);
  expect(mounted.container.textContent).toContain("Retained rows");
  expect(Array.from(mounted.container.querySelectorAll('button')).every(button => button.disabled)).toBe(true);
  mounted.rerender(<PaginatedListFrame {...props} loading loadingContent={<p>Loading</p>}><p>Rows</p></PaginatedListFrame>);
  expect(mounted.container.querySelector('[data-list-body]')?.textContent).toBe("Loading");
  mounted.rerender(<PaginatedListFrame {...props} errorContent={<p role="alert">Retry</p>}><p>Rows</p></PaginatedListFrame>);
  expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe("Retry");
  expect(change).not.toHaveBeenCalled();
});

it("shows loaded and unknown totals without manufacturing a global count", () => {
  mounted = renderTestUi(<PaginatedListFrame label="Loaded" rowNoun="records" meta={loadedListPaginationMeta(100, 1, 20)} onPageChange={vi.fn()}><p>Rows</p></PaginatedListFrame>);
  expect(mounted.container.textContent).toContain("trong 100 records đã tải");
  mounted.rerender(<PaginatedListFrame label="Cursor" rowNoun="records" meta={{ totalKind: "unknown", page: 2, start: 21, end: 40, hasPrevious: true, hasNext: true }} onPageChange={vi.fn()}><p>Rows</p></PaginatedListFrame>);
  expect(mounted.container.textContent).toContain("Hiển thị 21–40 records");
  expect(mounted.container.textContent).not.toContain(" / ");
});

it("bounds rendered rows for 10,000 loaded records and normalizes invalid numeric inputs", () => {
  const all = Array.from({ length: 10_000 }, (_, i) => i);
  const page = paginateListItems(all, 500, 20);
  expect(page.items).toEqual(all.slice(9980));
  mounted = renderTestUi(<PaginatedListFrame label="Large list" rowNoun="records" meta={page} onPageChange={vi.fn()}>
    <OperationalTable columns={["ID"]} rows={page.items.map(id => [String(id)])} />
  </PaginatedListFrame>);
  expect(mounted.container.querySelectorAll("tbody tr")).toHaveLength(20);
  expect(localListPaginationMeta(Number.NaN, Infinity, Number.NaN)).toMatchObject({ page: 1, pageSize: 1, total: 0, start: 0, end: 0 });
  expect(paginateListItems(all, -1, 20).items).toHaveLength(20);
});
