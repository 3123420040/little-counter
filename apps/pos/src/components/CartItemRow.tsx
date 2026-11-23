import { Minus, Plus, X } from "lucide-react";
import type { CartItem } from "../hooks/useCart";

interface CartItemRowProps {
  item: CartItem;
  isSelected: boolean;
  onSelect: () => void;
  onUpdateQty: (variantId: string, qty: number) => void;
  onRemove: (variantId: string) => void;
  disabled?: boolean;
  pricePending?: boolean;
}

export function CartItemRow({ item, isSelected, onSelect, onUpdateQty, onRemove, disabled = false, pricePending = false }: CartItemRowProps) {
  return (
    <div
      onClick={onSelect}
      className={[
        "flex items-center justify-between gap-2 py-2.5 px-3 cursor-pointer",
        "transition-colors duration-150 border-b border-border-default",
        "border-l-[3px]",
        isSelected
          ? "bg-surface-selected border-l-action-primary"
          : "border-l-transparent hover:bg-surface-hover",
      ].join(" ")}
    >
      <div className="min-w-0 flex-1">
        <p className="whitespace-normal break-words text-sm font-medium leading-snug text-text-primary">{item.productName}</p>
        <p className="text-xs text-text-muted">
          {item.quantity} × {pricePending ? "—" : `${item.unitPrice.toLocaleString("vi-VN")} ₫`}
        </p>
      </div>
      <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => onUpdateQty(item.variantId, item.quantity - 1)}
          disabled={disabled}
          className="flex h-8 w-8 items-center justify-center rounded border border-border-default text-text-muted hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Giảm số lượng"
        >
          <Minus size={12} />
        </button>
        <span className="w-8 text-center text-sm font-medium tabular-nums">{item.quantity}</span>
        <button
          onClick={() => onUpdateQty(item.variantId, item.quantity + 1)}
          disabled={disabled}
          className="flex h-8 w-8 items-center justify-center rounded border border-border-default text-text-muted hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Tăng số lượng"
        >
          <Plus size={12} />
        </button>
        <button
          onClick={() => onRemove(item.variantId)}
          disabled={disabled}
          className="ml-1 flex h-8 w-8 items-center justify-center rounded text-status-danger hover:bg-status-danger-bg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Xóa sản phẩm"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
