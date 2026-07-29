import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * The desktop target's 3-process build (`npm run dev:desktop` / `build:desktop`).
 * `main` + `preload` run in Node (externalize node_modules; the local
 * `harness/*` sources bundle in — they're node-free). The `renderer` is a normal
 * Vite React app rooted at `targets/desktop`, folding `harness/state.ts`'s
 * `reduce`. Source lives in `targets/desktop/`; this config is at the project
 * root because that's where `electron-vite` looks for it.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, "targets/desktop/main.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, "targets/desktop/preload.ts") },
    },
  },
  renderer: {
    root: resolve(__dirname, "targets/desktop"),
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve(__dirname, "targets/desktop/index.html") },
    },
  },
});
