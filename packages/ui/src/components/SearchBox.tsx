import { Search } from "lucide-react";
import type { ChangeEvent, InputHTMLAttributes } from "react";

export type SearchBoxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
  /** Placeholder text */
  placeholder?: string;
  onChange?: (value: string) => void;
};

/**
 * Search input with icon, styled consistently.
 *
 * @example
 * <SearchBox
 *   placeholder="Tìm sản phẩm, SKU, barcode..."
 *   value={query}
 *   onChange={e => setQuery(e.target.value)}
 * />
 */
export function SearchBox({ placeholder = "Tìm kiếm...", onChange, ...props }: SearchBoxProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange?.(event.target.value);
  };

  return (
    <label className="h-[var(--input-height)] min-w-[280px] flex items-center gap-2 px-2.5 border border-border-default rounded-md bg-surface-panel text-text-muted transition-colors duration-150 focus-within:border-action-primary">
      <Search size={15} aria-hidden="true" />
      <input
        type="search"
        placeholder={placeholder}
        onChange={handleChange}
        className="w-full border-0 outline-0 bg-transparent text-text-primary placeholder:text-text-muted text-sm"
        {...props}
      />
    </label>
  );
}
