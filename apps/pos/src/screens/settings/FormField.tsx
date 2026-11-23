/**
 * FormField.tsx
 * Reusable, accessible field wrapper used across merchant/store/profile forms.
 */
import { useId, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { PasswordInput } from "../../components/PasswordInput";

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  children?: ReactNode;
  required?: boolean;
}

export function Field({ label, error, hint, children, required }: FieldProps) {
  return (
    <label className="settings-field">
      <span className="settings-field-label">
        {label}
        {required && <span className="settings-required" aria-hidden="true"> *</span>}
      </span>
      {children}
      {error ? <span className="settings-field-error" role="alert">{error}</span> : null}
      {hint && !error ? <span className="settings-field-hint">{hint}</span> : null}
    </label>
  );
}

export function TextField(props: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  const id = useId();
  const { label, error, hint, ...rest } = props;
  const inputClassName = ["settings-input", error ? "settings-input--error" : ""].filter(Boolean).join(" ");
  return (
    <Field label={label} error={error} hint={hint} required={rest.required}>
      {rest.type === "password" ? (
        <PasswordInput id={id} inputClassName={inputClassName} {...rest} />
      ) : (
        <input id={id} className={inputClassName} {...rest} />
      )}
    </Field>
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: string }) {
  const id = useId();
  const { label, error, hint, ...rest } = props;
  return (
    <Field label={label} error={error} hint={hint} required={rest.required}>
      <textarea id={id} className={["settings-input settings-textarea", error ? "settings-input--error" : ""].filter(Boolean).join(" ")} {...rest} />
    </Field>
  );
}

export function SelectField(props: InputHTMLAttributes<HTMLSelectElement> & { label: string; error?: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const { label, error, hint, children, ...rest } = props;
  return (
    <Field label={label} error={error} hint={hint} required={rest.required}>
      <select id={id} className={["settings-input", error ? "settings-input--error" : ""].filter(Boolean).join(" ")} {...rest}>
        {children}
      </select>
    </Field>
  );
}
