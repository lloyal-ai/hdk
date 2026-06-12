# harness.dev

**Zero to a working agentic AI app in three commands.**

`harness.dev` is the CLI for the [lloyal HDK](https://github.com/lloyal-ai/hdk): scaffold a harness (your application), scaffold an App (a capability it loads), and ship Apps through the signed channel.

```bash
npx harness.dev              # scaffold a new harness — a runnable HDK application
npx harness.dev app          # scaffold an App — a Source + Tools + skill bundle
npx harness.dev install lloyal/wikipedia    # install a signed App from the channel
```

Every channel install is verified end-to-end: Ed25519-signed catalog and bundles, integrity-audited lockfile, install scripts disabled by default. What you install is what was reviewed.

For publishers:

```bash
npx harness.dev publishers register   # claim your publisher handle
npx harness.dev publish               # build, sign, and submit your App
npx harness.dev review                # (reviewers) inspect + approve submissions
```

**[Docs →](https://docs.lloyal.ai/cli)** · **[Build an App →](https://docs.lloyal.ai/build-an-app/what-is-an-app)** · **[The HDK →](https://github.com/lloyal-ai/hdk)**

## License

Apache-2.0 — the CLI is fully open. (The HDK runtime packages are FSL-1.1-Apache-2.0; see each package's LICENSE.)
