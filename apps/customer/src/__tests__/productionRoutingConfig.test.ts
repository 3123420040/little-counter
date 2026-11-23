import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("customer Scan & Go production routing config", () => {
  it("serves public shelf QR routes from the customer SPA, not the authenticated POS SPA", () => {
    const nginx = read("docker/nginx-pos.conf");

    expect(nginx).toMatch(/location \^~ \/s\/ \{\s*try_files \/customer\/index\.html =404;\s*add_header Cache-Control "no-store" always;\s*\}/m);
    expect(nginx).toContain("location / {\n        try_files $uri $uri/ /index.html;");
    expect(nginx).toContain('location = /index.html {\n        try_files /index.html =404;\n        add_header Cache-Control "no-store" always;');
  });

  it("lets production builds put customer assets under an isolated base path", () => {
    const viteConfig = read("apps/customer/vite.config.ts");

    expect(viteConfig).toContain('base: process.env.VITE_CUSTOMER_BASE || "/"');
  });
});
