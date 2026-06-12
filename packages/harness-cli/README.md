# harness.dev

The Harness Development Kit CLI — scaffold [HDK](https://github.com/lloyal-ai/hdk) harnesses and apps.

> **Early preview (0.1.x).** The command surface is in place; the scaffolders
> are landing in upcoming releases. Today the commands print their intended
> behavior rather than generating files.

```bash
npx harness.dev --help
```

## Commands

```
npx harness.dev <name>        Scaffold a new harness   (the default action)
npx harness.dev app <name>    Scaffold a new app
```

After a global install (`npm i -g harness.dev`) the same commands run as
`harness.dev <name>` — the package and the binary share the name, so the
invocation is identical either way.

## Concepts

- **Harness** — a runnable agentic product built on the HDK runtime.
- **App** — an installable capability (a Source + tools + a per-spawn
  contract) that a harness composes into its agent pool.

`harness.dev` is the authoring CLI for both.

## Requirements

- Node.js >= 20 (uses the built-in `node:util` argument parser; no runtime
  dependencies).

## License

Apache-2.0
