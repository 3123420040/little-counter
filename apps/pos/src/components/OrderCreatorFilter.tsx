import { Button } from "@medusa-snus/ui";
import type { CreatorOptionV1 } from "@medusa-snus/contracts";
import { useEffect, useRef } from "react";

export function OrderCreatorFilter({ options, selectedIds, selfOnly = false, pending = false, onChange }: {
  options: readonly CreatorOptionV1[];
  selectedIds: readonly string[];
  selfOnly?: boolean;
  pending?: boolean;
  onChange: (ids: string[]) => void;
}) {
  const selector = useRef<HTMLDetailsElement>(null);
  const focusedChoice = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (pending) return;
    const previous = focusedChoice.current;
    focusedChoice.current = null;
    if (previous && document.activeElement === document.body) {
      const index = options.findIndex((option) => option.operatorId === previous.value);
      selector.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index]?.focus();
    }
  }, [pending, options]);
  if (selfOnly) return (
    <div className="text-sm" aria-label="Người tạo đơn của tôi">
      Người tạo đơn: {options[0]?.displayName || "Tôi"} · Doanh số của tôi
    </div>
  );
  return (
    <details ref={selector} className="relative rounded-md border border-border-default bg-surface-panel p-2">
      <summary className="cursor-pointer text-sm focus-visible:outline"
        aria-label={pending ? "Đang xác định phạm vi người tạo đơn" : "Lọc người tạo đơn"}
        aria-disabled={pending || undefined} tabIndex={pending ? -1 : 0}
        onClick={(event) => { if (pending) event.preventDefault(); }}>
        {pending ? <span role="status">Chưa xác định phạm vi người tạo đơn.</span>
          : <>Người tạo đơn · {selectedIds.length ? `${selectedIds.length} đã chọn` : "Tất cả người tạo"}</>}
      </summary>
      {!pending && <div className="absolute left-0 z-20 mt-2 w-80 max-w-[80vw] rounded-md border border-border-default bg-surface-panel p-3 shadow-lg">
        <fieldset className="max-h-64 space-y-2 overflow-y-auto">
          <legend className="mb-2 text-xs text-text-muted">Chọn một hoặc nhiều người tạo đơn</legend>
          {options.map((option) => (
            <label key={option.operatorId} className="flex items-center gap-2 text-sm">
              <input type="checkbox" value={option.operatorId} checked={selectedIds.includes(option.operatorId)}
                onChange={(event) => {
                  focusedChoice.current = event.target;
                  onChange(event.target.checked ? [...selectedIds, option.operatorId].sort()
                    : selectedIds.filter((id) => id !== option.operatorId));
                }} />
              <span>{option.displayName} · {option.operatorId}{option.status === "historical" ? " (lịch sử)" : ""}</span>
            </label>
          ))}
          {!options.length ? <p className="text-sm text-text-muted">Chưa có danh sách người tạo đơn.</p> : null}
        </fieldset>
        <Button size="sm" variant="secondary" onClick={() => onChange([])}>Tất cả người tạo</Button>
      </div>}
    </details>
  );
}
