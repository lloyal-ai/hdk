// Installs the wss `window.harness` bridge as a side effect. `main.tsx` imports
// this FIRST (before the view), so `window.harness` exists when the view's effect
// runs — mirroring how desktop's preload injects it before the renderer loads.
import { installWebBridge } from "./web-bridge.js";

installWebBridge();
