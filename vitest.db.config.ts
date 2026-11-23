import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // DB tests intentionally share one mutable integration schema. A single
    // worker is required because migration DDL can deadlock with a SELECT from
    // another worker even when individual test files clean up correctly.
    maxWorkers: 1,
    fileParallelism: false,
    include: ["apps/**/*.db.test.{ts,tsx}", "packages/**/*.db.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
