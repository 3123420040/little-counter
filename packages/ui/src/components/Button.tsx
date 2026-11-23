import { forwardRef, type ReactNode, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon to show before label */
  icon?: ReactNode;
  children?: ReactNode;
};

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "border-action-primary bg-action-primary text-text-inverse hover:bg-action-primary-hover",
  secondary:
    "border-border-default bg-surface-panel text-text-secondary hover:bg-surface-subtle",
  danger:
    "border-status-danger-border bg-status-danger-bg text-status-danger hover:bg-red-100",
  ghost:
    "border-transparent bg-transparent text-text-secondary hover:bg-surface-subtle",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-[var(--button-height-sm)] px-2 text-xs",
  md: "h-[var(--button-height-md)] px-2.5 text-sm",
  lg: "h-[var(--button-height-lg)] px-3.5 text-base",
};

const ICON_WIDTH_CLASSES: Record<ButtonSize, string> = {
  sm: "w-[var(--button-height-sm)]",
  md: "w-[var(--button-height-md)]",
  lg: "w-[var(--button-height-lg)]",
};

/**
 * Standard button with variants used throughout the system.
 *
 * @example
 * <Button variant="primary" icon={<Check size={15} />}>Xác nhận</Button>
 * <Button variant="secondary">Hủy</Button>
 * <Button variant="danger" icon={<X size={15} />} />
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  className,
  ...props
}: ButtonProps, ref) {
  const isIconOnly = !children && icon;

  return (
    <button
      ref={ref}
      className={[
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap",
        "rounded-md font-medium transition-all duration-150",
        "border disabled:opacity-50 disabled:cursor-not-allowed",
        "focus-visible:outline-2 focus-visible:outline-action-primary focus-visible:outline-offset-2",
        "active:scale-[0.97]",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        isIconOnly ? `${ICON_WIDTH_CLASSES[size]} p-0` : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
});
