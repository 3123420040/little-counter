import type { KeyboardEvent } from "react";
import type { ContactType } from "../scan-go/types";

const CONTACT_OPTIONS: { value: ContactType; label: string; hint: string }[] = [
  { value: "whatsapp", label: "WhatsApp", hint: "+44 7..." },
  { value: "email", label: "Email", hint: "you@example.com" },
  { value: "phone", label: "Phone", hint: "+84 ..." },
];

/**
 * Optional, visually secondary contact capture. Labels sit above inputs
 * (never placeholder-only). Every field is skippable; the customer can
 * generate the cart QR with none of this filled in.
 */
export function ContactFields({
  nickname,
  contact,
  contactType,
  onNickname,
  onContact,
  onContactType,
}: {
  nickname: string;
  contact: string;
  contactType: ContactType;
  onNickname: (value: string) => void;
  onContact: (value: string) => void;
  onContactType: (value: ContactType) => void;
}) {
  const activeHint = CONTACT_OPTIONS.find((o) => o.value === contactType)?.hint ?? "";
  const moveContactType = (nextType: ContactType) => {
    onContactType(nextType);
    window.requestAnimationFrame(() => {
      document.getElementById(`sd-contact-type-${nextType}`)?.focus();
    });
  };
  const handleRadioKeyDown = (event: KeyboardEvent<HTMLButtonElement>, value: ContactType) => {
    const currentIndex = CONTACT_OPTIONS.findIndex((opt) => opt.value === value);
    const lastIndex = CONTACT_OPTIONS.length - 1;
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = lastIndex;
    else return;
    event.preventDefault();
    moveContactType(CONTACT_OPTIONS[nextIndex].value);
  };
  return (
    <div className="rounded-md bg-paper-band p-4 ring-1 ring-inset ring-hairline">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold uppercase tracking-wide text-ink-soft">Reach you (optional)</h3>
        <span className="text-[11px] font-semibold text-ink-muted">Skip is fine</span>
      </div>

      <div className="mt-3">
        <label htmlFor="sd-nickname" className="mb-1 block text-[13px] font-semibold text-ink-soft">
          Nickname
        </label>
        <input
          id="sd-nickname"
          type="text"
          autoComplete="nickname"
          value={nickname}
          onChange={(e) => onNickname(e.target.value)}
          placeholder="What should staff call you?"
          className="h-12 w-full rounded-md border-0 bg-card px-3.5 text-[15px] text-ink ring-1 ring-inset ring-hairline placeholder:text-ink-muted/60 focus:ring-2 focus:ring-dash"
        />
      </div>

      <div className="mt-3">
        <span className="mb-1 block text-[13px] font-semibold text-ink-soft">Contact type</span>
        <div role="radiogroup" aria-label="Contact type" className="grid grid-cols-3 gap-1.5">
          {CONTACT_OPTIONS.map((opt) => {
            const active = contactType === opt.value;
            return (
              <button
                key={opt.value}
                id={`sd-contact-type-${opt.value}`}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onContactType(opt.value)}
                onKeyDown={(event) => handleRadioKeyDown(event, opt.value)}
                className={[
                  "h-10 rounded-pill text-[13px] font-semibold transition-colors",
                  active ? "bg-ink text-paper" : "bg-card text-ink-soft ring-1 ring-inset ring-hairline",
                ].join(" ")}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-3">
        <label htmlFor="sd-contact" className="mb-1 block text-[13px] font-semibold text-ink-soft">
          {CONTACT_OPTIONS.find((o) => o.value === contactType)?.label ?? "Contact"}
        </label>
        <input
          id="sd-contact"
          type="text"
          inputMode={contactType === "email" ? "email" : "tel"}
          autoComplete={contactType === "email" ? "email" : "tel"}
          value={contact}
          onChange={(e) => onContact(e.target.value)}
          placeholder={activeHint}
          className="h-12 w-full rounded-md border-0 bg-card px-3.5 text-[15px] text-ink ring-1 ring-inset ring-hairline placeholder:text-ink-muted/60 focus:ring-2 focus:ring-dash"
        />
      </div>
    </div>
  );
}
