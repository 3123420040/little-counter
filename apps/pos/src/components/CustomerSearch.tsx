import { useState, useEffect } from "react";
import { Search, UserPlus } from "lucide-react";
import { useCustomers, useCreateCustomer } from "../hooks/useCustomers";
import { InlineError } from "@medusa-snus/ui";

interface CustomerSearchProps {
  onSelect: (customer: { id: string; phone: string; name: string }) => void;
  onClear: () => void;
  selectedPhone?: string;
  onDraftChange?: (draft: string) => void;
  resetToken?: number;
}

export function CustomerSearch({
  onSelect,
  onClear,
  selectedPhone,
  onDraftChange,
  resetToken = 0,
}: CustomerSearchProps) {
  const [phone, setPhone] = useState(selectedPhone || "");
  const [debounced, setDebounced] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(phone), 300);
    return () => clearTimeout(t);
  }, [phone]);

  useEffect(() => {
    setPhone(selectedPhone || "");
  }, [resetToken, selectedPhone]);

  const { data: customers } = useCustomers(debounced.length >= 3 ? debounced : undefined);
  const createMutation = useCreateCustomer();

  async function handleCreate() {
    if (!newName.trim() || !phone.trim()) return;
    setCreateError("");
    try {
      const result = await createMutation.mutateAsync({
        phone: phone.trim(), firstName: newName.trim(), lastName: "",
      });
      onDraftChange?.(phone.trim());
      onSelect({ id: result.customer.id, phone: phone.trim(), name: newName.trim() });
      setShowCreate(false);
      setNewName("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Không thể tạo khách hàng");
    }
  }

  function selectCustomer(c: { id: string; phone: string; first_name: string; last_name: string }) {
    setPhone(c.phone || "");
    onDraftChange?.(c.phone || "");
    onSelect({ id: c.id, phone: c.phone || "", name: `${c.last_name} ${c.first_name}`.trim() });
  }

  function changePhone(next: string) {
    setPhone(next);
    if (selectedPhone && next.trim() !== selectedPhone.trim()) onClear();
    onDraftChange?.(next);
  }

  function clearCustomer() {
    setPhone("");
    onDraftChange?.("");
    onClear();
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={phone}
            onChange={(e) => changePhone(e.target.value)}
            aria-label="Customer phone"
            placeholder="SĐT khách hàng..."
            className="h-8 w-full rounded-md border border-border-default bg-surface-panel pl-7 pr-2 text-xs
                       placeholder:text-text-muted focus:border-action-primary focus:outline-none
                       focus:ring-2 focus:ring-action-primary/20"
          />
        </div>
        {selectedPhone && (
          <button
            onClick={clearCustomer}
            className="text-xs text-text-muted hover:text-status-danger transition-colors"
          >
            Xóa
          </button>
        )}
      </div>

      {debounced.length >= 3 && (
        <div className="rounded-md border border-border-default bg-surface-panel overflow-hidden">
          {(customers || []).slice(0, 5).map((c) => (
            <button
              key={c.id}
              onClick={() => selectCustomer(c)}
              className="flex w-full items-center justify-between px-3 py-2 text-xs hover:bg-surface-hover transition-colors"
            >
              <span className="font-medium text-text-primary">
                {c.last_name} {c.first_name}
              </span>
              <span className="text-text-muted">{c.phone}</span>
            </button>
          ))}
          <button
            onClick={() => setShowCreate(true)}
            className="flex w-full items-center gap-1 border-t border-border-default px-3 py-2 text-xs
                       text-action-primary hover:bg-surface-hover transition-colors"
          >
            <UserPlus size={12} /> Khách mới
          </button>
        </div>
      )}

      {showCreate && (
        <div className="space-y-2 rounded-md border border-border-default bg-surface-panel p-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Tên khách hàng"
              className="h-8 flex-1 rounded border border-border-default px-2 text-xs
                         focus:border-action-primary focus:outline-none"
              autoFocus
            />
            <button
              onClick={handleCreate}
              disabled={!newName.trim() || createMutation.isPending}
              className="rounded bg-action-primary px-3 py-1.5 text-xs font-medium text-text-inverse
                         hover:bg-action-primary-hover transition-colors disabled:opacity-50"
            >
              {createMutation.isPending ? "Đang tạo" : "Tạo"}
            </button>
          </div>
          {createError && <InlineError message={createError} onRetry={() => setCreateError("")} />}
        </div>
      )}
    </div>
  );
}
