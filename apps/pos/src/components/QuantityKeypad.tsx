interface QuantityKeypadProps {
  onNumber: (n: number) => void;
  onIncrement: (n: number) => void;
  onDelete: () => void;
  onClear: () => void;
  selectedItemName?: string;
}

const BUTTONS = [
  "1", "2", "3", "+1", "4", "5", "6", "+5",
  "7", "8", "9", "⌫", "-1", "0", "+10", "Xóa",
] as const;

export function QuantityKeypad({
  onNumber, onIncrement, onDelete, onClear, selectedItemName,
}: QuantityKeypadProps) {
  function handleKey(key: string) {
    if (key === "⌫") return onDelete();
    if (key === "Xóa") return onClear();
    if (key === "+1") return onIncrement(1);
    if (key === "+5") return onIncrement(5);
    if (key === "+10") return onIncrement(10);
    if (key === "-1") return onIncrement(-1);
    onNumber(Number(key));
  }

  const getAriaLabel = (key: string) => {
    if (key === "⌫") return "Xóa sản phẩm đang chọn";
    if (key === "Xóa") return "Xóa giỏ hàng";
    if (key.startsWith("+")) return `Tăng ${key.slice(1)}`;
    if (key === "-1") return "Giảm 1";
    return `Đặt số lượng ${key}`;
  };

  return (
    <div className="shrink-0 border-t border-border-default bg-surface-panel px-3 py-2">
      <div className="mx-auto flex w-full max-w-[780px] flex-col gap-2 lg:flex-row lg:items-center">
        {selectedItemName && (
          <div className="min-w-0 rounded-md bg-surface-subtle px-3 py-2 text-xs text-text-muted lg:w-52">
            Đang chọn:{" "}
            <span className="font-medium text-text-primary">{selectedItemName}</span>
          </div>
        )}
        <div className="grid min-w-0 flex-1 grid-cols-4 gap-1.5 sm:grid-cols-8">
          {BUTTONS.map((k) => (
            <button
              key={k}
              type="button"
              aria-label={getAriaLabel(k)}
              onClick={() => handleKey(k)}
              className="flex h-[var(--pos-keypad-button)] min-w-0 items-center justify-center
                         rounded-md border border-border-default bg-surface-panel px-2 text-xs font-semibold
                         text-text-primary transition-colors duration-150
                         hover:bg-surface-hover active:bg-surface-selected
                         focus-visible:outline-2 focus-visible:outline-action-primary"
            >
              {k}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
