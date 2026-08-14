# @lloyal-labs/channel-verify

**The signature primitives for the Lloyal app channel.** Apache-2.0, zero
dependencies, zero native binaries, no I/O.

```ts
import {
  canonicalJson,
  catalogSignedBytes,
  verifyCatalogSignature,
  isWellFormedCatalog,
  CHANNEL_TRUST_ROOTS,
} from '@lloyal-labs/channel-verify';

if (!isWellFormedCatalog(parsed)) throw new Error('not a catalog');
const key = CHANNEL_TRUST_ROOTS.get(parsed.publisherKeyId);
if (!key) throw new Error('untrusted signing key');
if (!(await verifyCatalogSignature(parsed, key))) throw new Error('bad signature');
```

## What it does

The channel's trust chain starts with a **signed catalog** that names every app
and pins each version's `manifestUrl`, `tarballUrl` and `sizeBytes`. Each
bundle's manifest then carries an Ed25519 signature over the **raw tarball
bytes**. A client that can reproduce the exact bytes the platform signed for a
catalog, and verify an Ed25519 signature, can establish everything else by
cross-checking against the verified catalog.

Those two capabilities are what this package provides, and nothing else. It
fetches nothing, caches nothing, and makes no policy decisions.

## Why it is separate

Four copies of this encoding existed — the publish worker (which signs), the
rig (which verifies in-process), the CLI (which verifies at install time), and
a test file that mirrored the helper to use as its own oracle. They were
byte-identical, but nothing enforced it, and a copy that drifts does not fail
loudly: it makes every published app uninstallable.

The CLI's copy existed for a real reason this package also resolves. Importing
the rig pulls in the App runtime, which chain-imports the native
`@lloyal-labs/lloyal.node`; a CLI that scaffolds projects must not require a
native binary on the user's platform. This package costs neither side anything
— pure WebCrypto and string manipulation, so it runs unmodified in Node, in a
browser, and on workerd.

## `canonicalJson` defines the signature

Its output *is* the signed message. Any change to it — a different sort
comparator, escaped non-ASCII, a space after a separator — invalidates every
signature the platform has ever produced.

It is therefore pinned against **frozen bytes**: a real signed catalog, as
served, committed as a fixture and verified against the vendored trust root.
Not a round-trip — signing and verifying with the same helper cannot detect a
change applied to both sides at once, which is the failure mode that matters.

It is **not a general RFC 8785 implementation**, though it agrees with one on
the catalog's schema: keys sort by UTF-16 code unit (§3.2.3) and strings
serialise as ECMAScript `JSON.stringify` does (§3.2.2.2), which emits non-ASCII
raw. The live catalog's U+2014 is compatible with RFC 8785, not a divergence
from it.

What is missing is the validation half — no I-JSON checking, and non-finite
numbers silently become `null` where RFC 8785 requires rejection. That is safe
here because the input is always `JSON.parse` output over a constrained schema,
which can produce neither. Don't reuse it on arbitrary input expecting RFC 8785
guarantees.

## What stays with each consumer

Only provably-identical code lives here. Three things deliberately do not:

- **Fetching** — the rig's verifier is an Effection `Operation` with a memoizing
  cache; the CLI's is `async`/`await` with a headers deadline. Same trust chain,
  different runtimes.
- **Error prose** — the rig explains that the framework refuses to trust keys it
  does not vendor; the CLI is terse. `verifyCatalogSignature` returns a boolean
  so each caller keeps its own wording.
- **Version resolution** — the rig uses node-semver, the CLI hand-rolls a matcher
  to stay dependency-free, and they genuinely disagree on `'*'` against a
  prerelease and on `'>=1.0.0'`. Unifying them would change which version of an
  app gets installed, which is a decision to take deliberately rather than as a
  side effect of de-duplication.

## License

Apache-2.0. See [LICENSE](./LICENSE).
