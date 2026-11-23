const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

module.exports = [
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  {
    ignores: [
      "node_modules/**",
      "apps/pos/node_modules/**",
      "dist/**",
      "coverage/**",
      "test-results/**",
      "apps/ai/dist/**",
      "apps/pricing/dist/**",
      "apps/pos/dist/**",
      "apps/telegram/dist/**",
      "apps/customer/dist/**",
      "apps/customer/node_modules/**",
      "**/*.tsbuildinfo",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { require: "readonly", module: "readonly", __dirname: "readonly", __filename: "readonly", exports: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        document: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        window: "readonly",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        crypto: "readonly",
        document: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        HTMLInputElement: "readonly",
        import: "readonly",
        localStorage: "readonly",
        NodeJS: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        window: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "no-empty": "off",
      "no-undef": "off",
      "no-unused-expressions": "off",
      "prefer-const": "off",
    },
  },
];
