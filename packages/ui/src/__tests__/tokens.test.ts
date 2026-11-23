import { describe, expect, it } from "vitest";

const tokensCSS = `
:root {
  --color-white: #ffffff;
  --color-black: #111111;
  --color-neutral-50: #fafafa;
  --color-neutral-900: #18181b;
  --color-accent-600: #2563eb;
  --color-success-600: #059669;
  --color-warning-600: #d97706;
  --color-danger-600: #dc2626;
  --color-info-600: #0891b2;
  --surface-page: var(--color-neutral-50);
  --surface-panel: var(--color-white);
  --surface-subtle: var(--color-neutral-100);
  --text-primary: var(--color-neutral-900);
  --text-secondary: var(--color-neutral-700);
  --text-muted: var(--color-neutral-500);
  --text-inverse: var(--color-white);
  --status-success: var(--color-success-600);
  --status-success-bg: var(--color-success-50);
  --status-success-border: var(--color-success-200);
  --status-warning: var(--color-warning-600);
  --status-danger: var(--color-danger-600);
  --status-info: var(--color-info-600);
  --font-sans: Geist, ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --text-xs: 12px;
  --text-2xl: 24px;
  --weight-normal: 400;
  --weight-bold: 700;
  --leading-xs: 16px;
  --leading-3xl: 40px;
  --space-0: 0;
  --space-4: 16px;
  --space-12: 48px;
  --radius-sm: 4px;
  --radius-full: 999px;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-lg: 0 4px 6px rgba(0, 0, 0, 0.07);
  --sidebar-width: 232px;
  --topbar-height: 72px;
  --button-height-sm: 28px;
  --button-height-lg: 36px;
  --input-height: 36px;
  --pill-height: 22px;
  --icon-size-sm: 15px;
  --pos-product-card-size: 120px;
  --pos-cart-width: 400px;
  --transition-fast: 150ms ease;
  --transition-normal: 200ms ease;
  --z-sidebar: 10;
  --z-topbar: 20;
  --z-modal: 50;
  --z-toast: 100;
}
*,
*::before,
*::after {
  box-sizing: border-box;
}
body {
  margin: 0;
  -webkit-font-smoothing: antialiased;
}
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideInRight { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: translateX(0); } }
@media print { .sidebar, .topbar, .no-print { display: none !important; } }
`;

describe("Design Tokens", () => {
  it("has color primitives", () => {
    for (const t of ["--color-white", "--color-black", "--color-neutral-50", "--color-accent-600", "--color-success-600", "--color-warning-600", "--color-danger-600", "--color-info-600"]) {
      expect(tokensCSS).toContain(t);
    }
  });
  it("has semantic surface tokens", () => {
    for (const t of ["--surface-page", "--surface-panel", "--surface-subtle"]) expect(tokensCSS).toContain(t);
  });
  it("has text tokens", () => {
    for (const t of ["--text-primary", "--text-secondary", "--text-muted", "--text-inverse"]) expect(tokensCSS).toContain(t);
  });
  it("has status tokens", () => {
    for (const t of ["--status-success", "--status-success-bg", "--status-success-border", "--status-warning", "--status-danger", "--status-info"]) expect(tokensCSS).toContain(t);
  });
  it("has typography tokens", () => {
    for (const t of ["--font-sans", "--font-mono", "--text-xs", "--text-2xl", "--weight-normal", "--weight-bold", "--leading-xs", "--leading-3xl"]) expect(tokensCSS).toContain(t);
  });
  it("has spacing tokens", () => {
    for (const t of ["--space-0", "--space-4", "--space-12"]) expect(tokensCSS).toContain(t);
  });
  it("has radius + shadow tokens", () => {
    for (const t of ["--radius-sm", "--radius-full", "--shadow-sm", "--shadow-lg"]) expect(tokensCSS).toContain(t);
  });
  it("has layout tokens", () => {
    for (const t of ["--sidebar-width", "--topbar-height"]) expect(tokensCSS).toContain(t);
  });
  it("has component tokens", () => {
    for (const t of ["--button-height-sm", "--button-height-lg", "--input-height", "--pill-height", "--icon-size-sm"]) expect(tokensCSS).toContain(t);
  });
  it("has POS-specific tokens", () => {
    for (const t of ["--pos-product-card-size", "--pos-cart-width"]) expect(tokensCSS).toContain(t);
  });
  it("has transition + z-index", () => {
    for (const t of ["--transition-fast", "--transition-normal", "--z-sidebar", "--z-topbar", "--z-modal", "--z-toast"]) expect(tokensCSS).toContain(t);
  });
  it("has box-sizing reset", () => { expect(tokensCSS).toContain("box-sizing: border-box"); });
  it("has font smoothing", () => { expect(tokensCSS).toContain("-webkit-font-smoothing: antialiased"); });
  it("has animations", () => {
    for (const a of ["@keyframes spin", "@keyframes fadeIn", "@keyframes slideInRight"]) expect(tokensCSS).toContain(a);
  });
  it("has print media query", () => {
    expect(tokensCSS).toContain("@media print"); expect(tokensCSS).toContain(".no-print");
  });
});
