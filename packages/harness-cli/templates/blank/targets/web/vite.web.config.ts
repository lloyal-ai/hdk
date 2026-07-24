import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * The web target's browser app (`npm run dev:web` / `npm run build:web`). Rooted
 * at `targets/web`; it connects to the local `npm run serve` host over wss (see
 * `web-bridge.ts`). Point it elsewhere with `VITE_WSS_URL` or `?server=`.
 */
export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: resolve(__dirname, "../../dist-web"), emptyOutDir: true },
});
