// electron-builder packaging config for the desktop target (`npm run dist`).
//
// You DON'T need this to develop — `npm run dev:desktop` runs the app live. This
// is only for producing a distributable (a macOS .dmg). It's JS (not YAML) so
// signing can be ENV-DRIVEN: no Apple env → an UNSIGNED build you can preview
// locally; Apple env present → Developer-ID signed + notarized, no edit.
//
// The one non-obvious bit: the native runtime (@lloyal-labs/lloyal.node) is a
// prebuilt N-API addon — the `.node` and its sibling dylibs must sit co-located
// on disk, which they can't inside app.asar. So `asar:true` + `asarUnpack` the
// native package tree; everything else (incl. the forked cli engine, pure JS)
// stays packed. `npmRebuild:false` because the natives are prebuilts, not gyp.
//
// Branding is yours to add: drop `build/icon.icns` + set `mac.icon`, add a
// `build/entitlements.mac.plist` (+ `hardenedRuntime`) when you sign, and a
// `dmg.background` for the install window. Omitted here so an unsigned build
// works with zero assets.

const haveCert = !!process.env.CSC_LINK || !!process.env.CSC_NAME;
const willSign = haveCert;

module.exports = {
  appId: "__APP_ID__",
  productName: "__NAME_PASCAL__",
  directories: { output: "release" },
  asar: true,
  // Natives can't be dlopen'd from inside asar — keep the native tree on disk.
  asarUnpack: ["**/node_modules/@lloyal-labs/lloyal.node*/**"],
  npmRebuild: false,
  // App files; electron-builder adds the production node_modules tree — which is
  // where the forked cli engine lives (node_modules/.../bin/run.js is pure JS).
  files: ["out/**", "package.json"],
  mac: {
    category: "public.app-category.productivity",
    target: ["dmg"],
    // identity:null forces an UNSIGNED preview build; undefined lets
    // electron-builder auto-discover the Developer ID cert (CSC_LINK / keychain).
    identity: willSign ? undefined : null,
    hardenedRuntime: willSign,
    gatekeeperAssess: false,
  },
};
