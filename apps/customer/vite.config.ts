import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Public customer Scan & Go SPA. Anonymous, mobile-first.
// The public product URL lives under /s/:merchantSlug/:storeSlug/p/:qrSlug.
// In dev, Vite's SPA fallback serves index.html for every /s/... path.
// The mock service adapter runs fully client-side; flip VITE_SCAN_GO_LIVE=1
// to route the scan-go client through the /api proxy to the backend.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_CUSTOMER_BASE || "/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:9000",
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/api/, "") || "/",
      },
    },
  },
});
