# Synchronizing licensing documents

`hdk/GRANT.md` is the canonical **Developer Grant**. The canonical FAQ is
`hdk-docs/licensing/faq.md`; HDK commits its generated `LICENSE-FAQ.md` so that
package checks work from a standalone checkout.

After editing the grant, update every FSL workspace package in HDK:

```sh
npm run license:sync
npm run license:check
```

The sync discovers packages from `package.json` workspaces and their actual
`LICENSE` files. It requires each FSL package to include `LICENSE`, `GRANT.md`
and `LICENSE-FAQ.md` in its published `files` array. Independently licensed
packages such as Apache-licensed `channel-verify` are excluded. The sync never
edits a `LICENSE` file.

For a coordinated grant or FAQ update, supply all three other repository paths:

```sh
npm run license:sync -- \
  --docs-dir ../hdk-docs \
  --native-dir ../lloyal.node \
  --kernel-dir ../liblloyal
```

This strips the FAQ's leading YAML frontmatter, adds its standalone header,
and updates the FAQ and grant copies in HDK packages, `lloyal.node` and
`liblloyal`. If your kernel is a submodule, use
`--kernel-dir ../lloyal.node/liblloyal` instead. All paths must exist; missing
repositories are errors before any files are written. No directory is silently
skipped, and no repository is fetched, committed or pushed automatically.

`npm run license:check` performs a read-only check of the HDK copies. It needs
no sibling repositories, installs, builds or network. Supply the same three
repository paths to check the canonical docs FAQ and native/kernel copies too.
Local checks cannot detect a newer grant or FAQ in a different checkout;
coordinated changes must run the full check and include all affected repositories.

The previous `scripts/sync-license-faq.sh` command remains available as a wrapper
and accepts the same options. Its default now synchronizes the HDK grant and FAQ
copies locally; use the explicit repository paths for the full stack.

`npm run license:test` checks missing copies, drift, package publication lists,
frontmatter conversion and cross-repository preflight behavior using temporary
fixtures. CI and the release workflow check licensing before building or publishing.
