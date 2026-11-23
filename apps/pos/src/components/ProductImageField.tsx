import { useEffect, useState } from "react";
import { ImageOff, Package } from "lucide-react";

export interface ProductImageFieldProps {
  value: string;
  onChange: (value: string) => void;
}

export function validateProductImageUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return "URL hình ảnh phải dùng HTTPS.";
    if (parsed.username || parsed.password) return "URL hình ảnh không được chứa thông tin đăng nhập.";
    return null;
  } catch {
    return "URL hình ảnh không hợp lệ.";
  }
}

export function ProductImageField({ value, onChange }: ProductImageFieldProps) {
  const [loadFailed, setLoadFailed] = useState(false);
  const trimmed = value.trim();
  const validationError = validateProductImageUrl(value);
  const canPreview = Boolean(trimmed) && !validationError && !loadFailed;

  useEffect(() => {
    setLoadFailed(false);
  }, [value]);

  return (
    <div className="space-y-2">
      <div>
        <label className="mb-1 block text-xs text-text-muted" htmlFor="product-image-url">
          URL hình ảnh sản phẩm
        </label>
        <input
          id="product-image-url"
          type="url"
          value={value}
          placeholder="https://..."
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={Boolean(validationError)}
          aria-describedby="product-image-url-help product-image-url-error"
          className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
        />
        <p id="product-image-url-help" className="mt-1 text-[11px] leading-4 text-text-muted">
          Dùng ảnh HTTPS; có thể để trống để hệ thống tự tìm ảnh một lần sau khi lưu. Upload ảnh sẽ được xử lý ở phiên bản sau.
        </p>
        {validationError && (
          <p id="product-image-url-error" role="alert" className="mt-1 text-xs text-status-danger">
            {validationError}
          </p>
        )}
      </div>

      <div className="flex h-20 items-center justify-center overflow-hidden rounded-md border border-border-default bg-surface-subtle">
        {canPreview ? (
          <img
            key={trimmed}
            src={trimmed}
            alt="Xem trước ảnh sản phẩm"
            className="h-full w-full object-cover"
            onError={() => setLoadFailed(true)}
          />
        ) : (
          <div className="flex flex-col items-center gap-1 text-text-muted" role="status">
            {loadFailed ? <ImageOff size={20} /> : <Package size={20} />}
            <span className="text-[11px]">
              {loadFailed
                ? "Không tải được ảnh"
                : validationError
                  ? "URL ảnh không hợp lệ"
                  : "Chưa có ảnh"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
