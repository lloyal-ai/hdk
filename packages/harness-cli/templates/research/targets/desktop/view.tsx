/**
 * Desktop renderer entry — mounts the shared `HarnessApp` (see `App.tsx`). The
 * preload has already injected `window.harness` (IPC bridge) before this runs.
 */
import { createRoot } from "react-dom/client";
import { HarnessApp } from "./App.js";

createRoot(document.getElementById("root")!).render(<HarnessApp />);
