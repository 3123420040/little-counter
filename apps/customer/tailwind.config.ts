/** @type {import('tailwindcss').Config} */
// Scan & Go ("Stash Dash") design system.
// Distinct from the Snus Ops admin palette on purpose: the public customer
// flow has its own playful-premium retail language (paper / ink / tangerine).
// Colors reference RGB-channel CSS vars so opacity modifiers work.
const a = (channels: string) => `rgb(var(${channels}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: {
          DEFAULT: a("--paper-rgb"),
          band: a("--paper-band-rgb"),
          deep: a("--paper-deep-rgb"),
        },
        ink: {
          DEFAULT: a("--ink-rgb"),
          soft: a("--ink-soft-rgb"),
          muted: a("--ink-muted-rgb"),
        },
        dash: {
          DEFAULT: a("--dash-rgb"),
          deep: a("--dash-deep-rgb"),
          ink: a("--dash-ink-rgb"),
          tint: a("--dash-tint-rgb"),
        },
        frost: {
          DEFAULT: a("--frost-rgb"),
          tint: a("--frost-tint-rgb"),
        },
        ember: a("--ember-rgb"),
        card: a("--card-rgb"),
        hairline: a("--hairline-rgb"),
        scrim: "var(--ink-scrim)",
      },
      fontFamily: {
        display: [
          "Inter",
          "Helvetica Neue",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        "strength-xl": ["clamp(3.25rem, 17vw, 5.75rem)", { lineHeight: "0.9", letterSpacing: "-0.04em" }],
        "price-xl": ["clamp(2rem, 9.5vw, 3rem)", { lineHeight: "1", letterSpacing: "-0.02em" }],
      },
      borderRadius: {
        xs: "var(--r-xs)",
        sm: "var(--r-sm)",
        md: "var(--r-md)",
        lg: "var(--r-lg)",
        pill: "9999px",
      },
      boxShadow: {
        lift: "var(--shadow-lift)",
        pop: "var(--shadow-pop)",
        qr: "var(--shadow-qr)",
      },
      maxWidth: {
        shelf: "440px",
      },
    },
  },
  plugins: [],
};
