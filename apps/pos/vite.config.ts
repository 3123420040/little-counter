import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:9000",
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/api/, "") || "/",
      },
      // Keep the exact /ai path available for the SPA route; proxy only AI API calls.
      "^/ai/": process.env.VITE_AI_PROXY_TARGET || "http://localhost:3002",
    },
  },
});
