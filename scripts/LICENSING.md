# Synchronizing licensing documents

`hdk/LICENSE` is the canonical **FSL-1.1-MIT** license and `hdk/GRANT.md` is the
canonical **Developer Grant**. The canonical FAQ is
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
packages such as Apache-licensed `channel-verify` are excluded. Every FSL
variant is detected: an old Apache-future workspace cannot silently fall out
of scope. FSL package licenses must match HDK's license byte for byte, and an
explicit package license identifier must be `FSL-1.1-MIT` (the existing
`SEE LICENSE IN LICENSE` declaration is also accepted). The sync never edits a
`LICENSE` file. Review and update license files explicitly before synchronizing
their accompanying documents.

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
repositories are errors before any files are written. Native and kernel
licenses must match HDK's license byte for byte. The license body between the
dividers in `hdk-docs/licensing/fsl-template.md` must also match after its
copyright parameters are substituted. No directory is silently skipped, and
no repository is fetched, committed or pushed automatically.

`npm run license:check` performs a read-only check of the HDK copies. It needs
no sibling repositories, installs, builds or network. Supply the same three
repository paths to check the canonical docs FAQ and native/kernel copies too.
Local checks cannot detect a newer grant or FAQ in a different checkout;
coordinated changes must run the full check and include all affected repositories.

The previous `scripts/sync-license-faq.sh` command remains available as a wrapper
and accepts the same options. Its default now synchronizes the HDK grant and FAQ
copies locally; use the explicit repository paths for the full stack.

`npm run license:test` checks missing copies, mixed FSL variants, changed terms,
package publication lists, frontmatter conversion and cross-repository preflight
behavior using temporary fixtures. CI and the release workflow check licensing
before building or publishing.

## Releasing the MIT-future transition

This is a forward transition for versions made available with FSL-1.1-MIT.
Those versions receive an additional MIT license on their second anniversary;
they are not immediately MIT-licensed. Preserve previous tags, artifacts,
licensing documents and first-availability dates. Versions already distributed
under FSL-1.1-Apache-2.0 retain their irrevocable Apache 2.0 future grant and
original conversion clock. Do not overwrite an existing package or catalog
artifact to change its license.

Merging the coordinated licensing changes updates source and documentation.
Published installations need a separately authorized release with new versions
and updated dependency pins. Use this order:

1. Land the `liblloyal` license and grant, then update `lloyal.node`'s kernel
   submodule to that commit. Verify the pinned kernel has the new documents
   before building.
2. Release a new native version with its platform npm packages and the signed
   R2 backend artifacts. Inspect the shipped root and nested legal files;
   third-party licenses, including llama.cpp and CUDA, retain their own terms.
3. Update native dependency pins and release the affected HDK npm runtime
   packages. Inspect their packed `LICENSE`, `GRANT.md` and `LICENSE-FAQ.md`.
4. Build and publish new signed catalog bundles for all four first-party
   abilities: web, corpus, documents and Wikipedia. The HDK npm publish loop
   does not publish these abilities.
5. Update CLI template and application dependency pins to the released
   versions, then release the CLI and rebuild distributed applications as
   needed. The CLI and Fieldnote's own MIT licenses remain unchanged.

The CLI's default `scripts/release-set.mjs` only releases HDK and the CLI. It
does not release the native layer or signed ability bundles, so that command
alone cannot complete this transition. Verify the actual packed and downloaded
artifacts across each distribution channel before describing the release as
fully migrated. No release, version bump, tag or publish is performed by the
licensing sync commands.
