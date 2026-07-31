import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/.well-known": "http://localhost:3000",
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/mcp": "http://localhost:3000",
      "/oauth2": "http://localhost:3000",
    },
  },
});
