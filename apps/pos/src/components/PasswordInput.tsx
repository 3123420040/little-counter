import { useId, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  inputClassName?: string;
  showLabel?: string;
  hideLabel?: string;
};

export function PasswordInput({
  id,
  className,
  inputClassName,
  showLabel = "Hiện mật khẩu",
  hideLabel = "Ẩn mật khẩu",
  disabled,
  ...props
}: PasswordInputProps) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const [visible, setVisible] = useState(false);
  const label = visible ? hideLabel : showLabel;
  const Icon = visible ? EyeOff : Eye;

  return (
    <div className={["password-input", className].filter(Boolean).join(" ")}>
      <input
        {...props}
        id={inputId}
        type={visible ? "text" : "password"}
        disabled={disabled}
        className={["password-input-control", inputClassName].filter(Boolean).join(" ")}
      />
      <button
        type="button"
        className="password-input-toggle"
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => setVisible((current) => !current)}
      >
        <Icon size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
