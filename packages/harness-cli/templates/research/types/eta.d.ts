/**
 * `.eta` files are prompt-template sources. esbuild's `--loader:.eta=text`
 * inlines them as string constants into the bundle at build time, so the
 * running bundle does no fs.readFileSync. (The sources themselves DO ship as
 * src/prompts/*.eta via the `files` whitelist — they're just carried inlined,
 * not read from disk.) This ambient declaration is TYPE-only: it satisfies
 * tsc for the imports but provides NO runtime loader, so a module that imports
 * `.eta` must be esbuilt — it cannot be executed as raw TS under tsx/node.
 */
declare module '*.eta' {
  const content: string;
  export default content;
}
