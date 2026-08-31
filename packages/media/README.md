# @lloyal-labs/media

Content addressing for a harness: the **content-addressed storage format** a
run writes its media to, and the normalizer that decides which pixels are
admitted to it.

Both live here because they are the same decision viewed from either end — what
a harness stores and what it normalizes — and the package is split by RUNTIME,
not by concept:

| entry | holds | needs |
|---|---|---|
| `@lloyal-labs/media` | the OCI shapes, the store and ingress contracts, `materialize` | nothing — browser-safe, and a dependency root |
| `@lloyal-labs/media/node` | `FileAttachmentStore` (the layout on disk), `createImageIngress` (sharp) | `node:fs`; `sharp` as an optional peer |

`.` cannot import `./node`, which is what keeps the first row true.

**Three axes decide what belongs where**, and re-deriving them is how this ends
up merged again:

- **format** — how bytes are addressed and laid out (OCI). This package.
  Stable, published, nothing image-specific in it.
- **policy** — where a project puts them and what is gated.
  `createProjectMediaStore` in `@lloyal-labs/rig`, plus the template.
- **stream** — what fits in an event and is therefore ALREADY in the trace.

The boundary is **"too big for the event stream"**, not "media": text turns and
tool results ride the trace verbatim, while a 180 KB image would stringify to
~700k characters of JSON digits — which is why it is a marker plus a digest.

**"Media" means two things here**, and both are load-bearing. OCI's sense is
*typed bytes* (`mediaType`, `sniffMediaType`, the `media/` directory); the
modality sense is *pictures and sound* (what a projector decodes). The format
half is indifferent to modality — a video or a rasterized page is the same
manifest graph as an image.

---

## Why content-addressed at all

A trace records the media **marker**, never the pixels. So a media-bearing run
cannot be replayed from the trace alone, and the rule that falls out is:

> Anything that reaches model state must be addressable, or the run is not
> replayable.

That makes the content store a **correctness requirement, not telemetry** —
which is why it is never gated behind a dev flag, and why it lives in the
project rather than beside a trace file.

## The format is the OCI Image Layout

Not "OCI-inspired". A store directory is a **valid OCI Image Layout**, so
`oras` and `crane` can push it to any registry with none of our code in the
path — which is what makes distribution a later, replaceable adapter rather
than a rewrite.

**You do not have to take that on trust, and neither does a reviewer.**
`npm run verify:oci` builds a layout through the real ingress and drives `oras`
against it with none of our code involved, then drives our reader against a
layout `oras` itself wrote. It runs in CI on every push (job
`oci-conformance`). Seven checks:

| | |
|---|---|
| 1 | the three entries `image-layout.md` requires, and only digest-named blobs |
| 2 | `oras` reads the manifest — `schemaVersion`, layers, roles |
| 3 | `oras` computes the SAME digest we recorded |
| 4 | the canonical empty config blob EXISTS and fetches as `{}` |
| 5 | every layer retrieves at its declared size |
| 6 | `oras cp` preserves the digest into a layout `oras` lays out itself |
| 7 | our `materialize()` — the exact call replay makes — rebuilds from that layout |

Check 4 has its own line because it is the easy conformance bug: a puller
fetches the config like any other blob, so a manifest that only NAMES OCI's
canonical empty descriptor looks correct locally and fails everywhere else.

```
<store>/
  oci-layout                     {"imageLayoutVersion":"1.0.0"}
  index.json                     image index — the entry point
  blobs/sha256/<64 hex>          every blob, addressed by content
```

Specs this conforms to:

| | |
|---|---|
| [image-layout.md](https://github.com/opencontainers/image-spec/blob/main/image-layout.md) | the three required entries above |
| [descriptor.md](https://github.com/opencontainers/image-spec/blob/main/descriptor.md) | `mediaType` + `digest` + `size`, digest as `<algorithm>:<encoded>` |
| [manifest.md](https://github.com/opencontainers/image-spec/blob/main/manifest.md) | `schemaVersion: 2`, required `config`, `layers` with ≥1 entry, `artifactType` |
| [OCI Distribution](https://github.com/opencontainers/distribution-spec) | not implemented — see *Deferred* |

## An attachment is a manifest, never a blob

This is the load-bearing decision, and the one that is expensive to retrofit.

An image today is one representation and perhaps a source. A video is a source
plus N sampled frames. A live capture is frames with **no** source. Because the
fold and the replay path hold a pointer to a *manifest*, each of those is an
additive change to this file and invisible above it.

```jsonc
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "artifactType": "application/vnd.lloyal.attachment.v1",
  "config": {                                  // OCI's canonical empty blob:
    "mediaType": "application/vnd.oci.empty.v1+json",
    "digest": "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    "size": 2                                  // an artifact manifest still REQUIRES a config
  },
  "layers": [
    { "mediaType": "image/jpeg", "digest": "sha256:…", "size": 41022,
      "annotations": {
        "ai.lloyal.role": "representation",     // what entered the cache
        "ai.lloyal.derive.maxPixels": "4194304",
        "ai.lloyal.derive.quality": "82"
      } },
    { "mediaType": "image/png",  "digest": "sha256:…", "size": 180311,
      "annotations": { "ai.lloyal.role": "source" } }   // what the user supplied
  ]
}
```

### The `config` slot is not permanently empty

An image has nothing to say beyond its layers, so its manifest carries OCI's
canonical empty blob. Timed media will not: a video needs a timeline —
timestamps, track descriptors, the sampling policy, frame-to-audio
correspondence — and [annotations are `map<string,string>`](https://github.com/opencontainers/image-spec/blob/main/annotations.md),
so encoding that as JSON inside an annotation would be unvalidatable string
soup. A typed config blob is what OCI provides the slot for.

`putAttachment({ config })` already accepts one. A reader branches on
`config.mediaType`, so introducing `application/vnd.lloyal.attachment.config.v1+json`
later is additive — existing image manifests keep the empty descriptor and stay
valid.

### Annotations we define

`org.opencontainers.*` is reserved by the spec, so ours are reverse-DNS under
`ai.lloyal`.

| key | meaning |
|---|---|
| `ai.lloyal.role` | `representation` (entered the cache) or `source` (as supplied) |
| `ai.lloyal.derive.*` | the parameters a representation was derived **under** |

**`ai.lloyal.derive.*` is a correctness requirement, not provenance.**
Normalization is parameterized — pixel ceiling, quality, the projector's own
token budget — so one source under two settings yields different pixels and
therefore different KV. Addressing the *derived* bytes and recording what
derived them is what stops a replay under changed config from silently
rebuilding a different cache state.

Retaining a source is optional and meaningful: it is what permits
re-derivation later — a better sampler, or a model that reads video natively.
Omitting it is a legitimate choice for a large original.

## Normalization

`normalizeImage(bytes, opts)` guarantees two things the projector otherwise
enforces too late:

- **Format** — the result is one of jpeg/png/bmp/gif. A file picker's `accept`
  is advisory (drag-and-drop and paste bypass it), so without this an
  unsupported file fails inside the decoder mid-run, on a branch already in
  flight.
- **Size** — anything above the pixel ceiling is downscaled here rather than by
  the projector, which would do it anyway *after* the bytes crossed a socket
  and were decoded. The model sees the same pixels either way.

It re-encodes only when it must, so an image already in an accepted format and
within the ceiling comes back untouched and is never degraded twice.

### What normalization buys — and what it does not

It buys **wire bytes** (at the default ceiling, ~73% on a large photo), **format
conformance**, and **decoder work**. It does **not** buy KV. At the default the
ceiling is the projector's own, so normalizing performs the downscale the
projector would have performed anyway, earlier — the model sees the same pixels
and the same cell count either way. Below the default it does change cells, but
that is a fidelity decision, not an optimization.

### The admission policy

Byte-identical pass-through is permitted only when ALL of these hold:

| | |
|---|---|
| format | one the projector decodes |
| size | under the pixel ceiling |
| dimensions | known — read from the header when the decoder cannot read the file at all |
| EXIF orientation | identity (`1`) |
| colour | no ICC profile, or an sRGB one |

Anything else is **derived**, and the original is retained as the `source`
layer. The last two are not precautionary. The projector loads through
`stb_image`, which contains no EXIF handling and ignores ICC entirely — so a
tag left on a pass-through is a tag nobody downstream reads, and a portrait
phone photo small enough to skip the ceiling would reach the model sideways
with nothing left to say so. Size was never what made that safe.

**Known limit:** a non-sRGB profile forces derivation, and derivation strips
the profile, so every admitted representation ends up with one consistent
interpretation. The pixels are not converted — sharp/libvips performs no ICC
transform (measured). What this removes is the asymmetry, where colour handling
depended on whether an image happened to exceed the ceiling.

Normalization is also where content is **inspected before it is addressed**,
which is why images need no separate staging area — the payload fits in memory.
Video is exactly where that stops being true.

## Deferred, and why none of it is foreclosed

| | |
|---|---|
| **OCI Distribution** | The layout is already pushable by the mature Go CLIs. A client of our own waits until content must move between placements. |
| **Resumable ingress** (tus) | Appears when a payload outgrows memory — as an adapter in front of this store, not a change to it. Note the trust boundary: untrusted bytes stage, get inspected, and only then are admitted. |
| **Video derivation** | The manifest already has the slot: source + N frame representations. What is missing is a decoder, and that decision carries real licensing and codec-patent weight. |
| **Live capture** | The *locator* is not addressable; every bounded frame that reaches model state still is. Attachments are already per-prefill rather than per-run, so a live run is many prefills — no growing manifest. |
| **Reachability GC** | Nothing here deletes. Deletion needs refcounting across briefs that may share a digest. |

## Two invariants worth stating explicitly

**`index.json` is a catalogue, never the runtime authority.** Resolution goes
straight to `blobs/<algorithm>/<encoded>`; nothing on the replay path reads the
index. A lost concurrent index update can hide an attachment from OCI tooling —
it can never invalidate a recorded run.

**Write order is blobs → manifest → index.** A crash can leave orphan blobs,
which are harmless and unreferenced. It can never leave a committed manifest
pointing at content that is not there.

## Known limitations

- **`index.json` is a mutable shared root**, updated read-modify-write. Writes
  are synchronous, so concurrent Sessions inside one host process serialize
  safely; two *processes* writing one layout can lose an index entry. Blobs are
  unaffected — content-addressed, written temp-then-rename — so the loss is
  discoverability by other OCI tooling, never replay.
- **`skopeo` is untested, and is not owed.** It is container-image tooling and
  is entitled to reject an artifact manifest whose config is not an image
  config. `oras` is the artifact-native tool and is the one that settles this.
- **`sharp` is a peer concern.** `normalizeImage` requires it at call time
  rather than importing it at module load, so a harness that never accepts an
  image pays nothing and one that does gets a message naming the install.
