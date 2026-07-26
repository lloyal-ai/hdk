// Web renderer entry. The side-effect import runs FIRST — it installs
// `window.harness` (the wss bridge) before the shared view mounts and subscribes.
import "./boot.js";
import { createRoot } from "react-dom/client";
import { HarnessApp } from "../desktop/App.js";

createRoot(document.getElementById("root")!).render(<HarnessApp />);
