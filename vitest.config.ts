import { defineConfig } from "vitest/config";
import path from "node:path";

const setupFiles = ["./vitest.setup.ts"];

export default defineConfig({
  resolve: {
    alias: {
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
      "react/jsx-runtime": path.resolve(__dirname, "node_modules/react/jsx-runtime.js"),
      "react/jsx-dev-runtime": path.resolve(__dirname, "node_modules/react/jsx-dev-runtime.js"),
      "react-router-dom": path.resolve(__dirname, "node_modules/react-router-dom"),
      "react-router": path.resolve(__dirname, "node_modules/react-router"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    env: { DATABASE_URL: "postgresql://127.0.0.1:1/unused_test" },
    setupFiles,
    include: ["packages/**/*.test.{ts,tsx}", "apps/**/*.test.{ts,tsx}", "plugins/**/*.test.{ts,tsx}"],
    exclude: ["**/*.db.test.{ts,tsx}", "**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      include: ["packages/domain/src/**", "packages/application/src/**"],
      thresholds: {
        "packages/domain/src/**": { statements: 95, branches: 90 },
        "packages/application/src/**": { statements: 80, branches: 70 },
      },
    },
  },
});
