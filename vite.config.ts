import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
  },
  server: {
    proxy: {
      "/.well-known": "http://localhost:3000",
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/mcp": "http://localhost:3000",
    },
  },
});
