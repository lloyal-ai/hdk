/**
 * `@lloyal-labs/ui` — the view side of a harness, for React.
 *
 * The provider connects a bridge's projection once; the hooks read the fold,
 * the wire's status, the command sink and the content plane's origin. The
 * primitives are the pieces every harness view rebuilt: markdown with math,
 * the one enlarged view of an asset, and what a root is. The generic agent
 * fold is framework-free and lives at `@lloyal-labs/ui/fold`, so a fold that
 * runs where React does not (a terminal, a desktop shell's own process) takes
 * that entry alone; a markdown body's headings, links and heading ids are
 * `@lloyal-labs/ui/prose`, framework-free too.
 *
 * Browser-safe: nothing here imports a Node module.
 *
 * @packageDocumentation
 * @category UI
 */
export { HarnessProvider, projectionFor, useHarness, useProjection, useSend, useConnection, useAvailability, useRecover, useInstall, useChooseFile, useContentOrigin } from './provider.js';
export type { Harness, ChooseFile, ChooseFileOpts } from './provider.js';
export { Installer } from './installer.js';
export type { InstallerProps, InstallerStep } from './installer.js';
export { Markdown } from './markdown.js';
export type { MarkdownComponents } from './markdown.js';
export { Lightbox } from './lightbox.js';
export type { LightboxProps } from './lightbox.js';
export { resolveAsset, useAssets, pageFacts, pageList } from './assets.js';
export type { Asset } from './assets.js';
export * from './fold.js';
export * from './prose.js';
