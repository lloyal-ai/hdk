# @lloyal-labs/media

Attach an image to a run and three things become true: the run **replays** from
the exact bytes the model originally saw, those bytes stay **inspectable** for
as long as the project exists, and the store holding them is a **valid OCI
Image Layout** — `oras` pushes a run's media to any registry with none of this
package's code in the path. The artifact infrastructure you already operate
can host your model's inputs.

The mechanism is content addressing at the point of admission. A trace records
a reference for every image, never the pixels, so the store is what makes a
media-bearing run reproducible — it is part of the run's correctness and is
always on. Everything is addressed by digest, so attaching the same file twice
writes nothing new.

## Quickstart

```bash
npm i @lloyal-labs/media
npm i sharp              # only in a process that admits image uploads — see below
npm i @embedpdf/pdfium   # only in a process that admits PDF uploads
```

```ts
import { materialize } from '@lloyal-labs/media';
import { FileAttachmentStore, createContentIngress } from '@lloyal-labs/media/node';

const store = new FileAttachmentStore('media');        // a valid OCI Image Layout
const ingress = createContentIngress(store);           // sniff → admit → address → commit

const attachment = await ingress.ingest(bytes);        // one root descriptor
const { bitmaps } = materialize(store, [attachment]);  // the exact admitted pixels — none for a document
```

`ingest` admits bytes and returns a root descriptor small enough to ride any
wire. The bytes decide the door: an image goes through the normalizer
(`createImageIngress` — converting, downscaling and stripping as the admission
policy below requires), a PDF through the document ingress
(`createDocumentIngress`, below); each is also exported on its own. `materialize` is the inverse: given roots, it returns
the exact bytes to hand the projector (the model's vision encoder). Replay is
`materialize` called later.

In a lloyal harness you rarely wire this yourself: `@lloyal-labs/rig`
constructs the project store, and the runtime carries attachments through
trace and replay. This package is the format and the gate.

## Two entry points, split by runtime

| entry | holds | needs |
|---|---|---|
| `@lloyal-labs/media` | the OCI shapes, the store and ingress contracts, `materialize` | nothing — browser-safe, zero dependencies |
| `@lloyal-labs/media/node` | `FileAttachmentStore` (the layout on disk), `createContentIngress` — `createImageIngress` (sharp) and `createDocumentIngress` (PDFium) | `node:fs`; `sharp` and `@embedpdf/pdfium` as optional peers |

The root entry never reaches `node:`, `sharp` or the codec — enforced by
`npm run verify:packed`, which walks the packed artifact's require graph on
every push. Both are required at call time, not module load, so a process
that never accepts an image or a document pays nothing, and one that does
gets an error naming the install.

Where things live: the **format** — how bytes are addressed and laid out — is
this package. The **policy** — where a project keeps its store — is
`createProjectMediaStore` in `@lloyal-labs/rig`. The trace carries only
references, because a 180 KB image would stringify to ~700k characters of JSON
digits in an event stream sized for text.

One vocabulary note: `mediaType` is OCI's word for *typed bytes* and applies
to every blob, text included; "media" elsewhere in this README means the
modality — pictures, and eventually sound. The format half is indifferent to
modality: a video or a rasterized page is the same manifest graph as an image.

## The store is an OCI Image Layout

```
<store>/
  oci-layout                     {"imageLayoutVersion":"1.0.0"}
  index.json                     image index — the entry point
  blobs/sha256/<64 hex>          every blob, addressed by content
```

`npm run verify:oci` is the receipt. It builds a layout through the real
ingress, drives `oras` against it with none of our code involved, then drives
our reader against a layout `oras` itself wrote — in CI, on every push:

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
fetches the config like any other blob, so a manifest that only *names* OCI's
canonical empty descriptor looks correct locally and fails everywhere else.

Specs, per requirement:

| | |
|---|---|
| [image-layout.md](https://github.com/opencontainers/image-spec/blob/main/image-layout.md) | the three required entries above |
| [descriptor.md](https://github.com/opencontainers/image-spec/blob/main/descriptor.md) | `mediaType` + `digest` + `size`, digest as `<algorithm>:<encoded>` |
| [manifest.md](https://github.com/opencontainers/image-spec/blob/main/manifest.md) | `schemaVersion: 2`, required `config`, `layers` with ≥1 entry, `artifactType` |
| [OCI Distribution](https://github.com/opencontainers/distribution-spec) | not implemented — see *Deferred* |

## One manifest shape, from image to video to live capture

An attachment references a **manifest**, and the manifest is where modality
lives. An image is one representation and perhaps a source. A video is a
source plus N sampled frames. A live capture is frames with no source. Each of
those is the same graph, so extending to a new modality changes this package
and nothing above it.

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
        "ai.lloyal.role": "representation",     // what the model saw
        "ai.lloyal.derive.maxPixels": "4194304",
        "ai.lloyal.derive.quality": "82"
      } },
    { "mediaType": "image/png",  "digest": "sha256:…", "size": 180311,
      "annotations": { "ai.lloyal.role": "source" } }   // what the user supplied
  ]
}
```

The `config` slot is empty for an image, which has nothing to say beyond its
layers. A document fills it (next section), and timed media will: a timeline —
timestamps, track descriptors, sampling policy — is typed structured data, and
[annotations are `map<string,string>`](https://github.com/opencontainers/image-spec/blob/main/annotations.md),
so the config blob is where such things belong. A reader branches on
`config.mediaType`, so a manifest with the empty config stays valid beside one
with a sidecar.

## A document is the same graph

A PDF admitted through `createDocumentIngress` becomes one manifest whose
representation is what the model reads, whose source is the file as supplied,
and whose config is a **sidecar** of facts about the document:

```jsonc
{
  "artifactType": "application/vnd.lloyal.attachment.v1",
  "config": { "mediaType": "application/vnd.lloyal.document.v1+json", "digest": "sha256:…", "size": 2210 },
  "layers": [
    { "mediaType": "text/markdown",   "digest": "sha256:…", "size": 18342,
      "annotations": { "ai.lloyal.role": "representation" } },     // what the model reads
    { "mediaType": "application/pdf", "digest": "sha256:…", "size": 812044,
      "annotations": { "ai.lloyal.role": "source" } }              // what the user supplied
  ]
}
```

The sidecar (`DocumentMeta`, guarded by `asDocumentMeta` on the root entry)
records the title; the sections with their heading path, line span and pages;
a page map with per-page counts — characters, image objects, path objects,
tagged tables and figures; the figures with their captions; the tagged tables;
and the parameters the derivation ran under. Facts, not verdicts: whether a
page is worth spending a model's attention on is a rule the reader applies
over the counts. Lines are 1-based over the markdown's `\n` split, and
`pagesOf(meta, startLine, endLine)` is the one function that turns a line
span into pages.

Every page within the render bound, and every figure crop, is its own
single-image manifest — a **page root** — named from the sidecar by
descriptor. A page root is an ordinary image attachment carrying `pdf.v1`
derive annotations, so the normalizer never runs on it and `materialize`,
replay and any OCI tool read it exactly as they read a photo:

| key | value |
|---|---|
| `ai.lloyal.derive.profile` | `pdf.v1` |
| `ai.lloyal.derive.page` | the 1-based page it renders |
| `ai.lloyal.derive.dpi`, `.width`, `.height`, `.format` | how it was rendered |
| `ai.lloyal.derive.source` | the digest of the PDF blob it was rendered from |
| `ai.lloyal.derive.bbox` | a figure crop's box on the page, in PDF user space |

`materialize` projects only representations in a format the projector
decodes. A document root therefore yields no bitmaps — its text is for
retrieval, not the vision encoder — while a page root yields one. That single
rule is what lets a document ride the same wire, trace and replay as an image
without anything upstream learning a new kind.

Bounds are declared constants on the node entry: `MAX_DOCUMENT_BYTES` (32 MiB,
refused before the codec sees a byte), `MAX_RENDERED_PAGES` (200 — page one
first, then graphics-bearing pages, then the rest, so the archive under the
bound is a deterministic function of the input; a page past it simply has no
render descriptor), `MAX_TEXT_PAGES` (400), `MAX_FIGURES` (16), and
`DOCUMENT_TIMEOUT_MS` (120 s — a failure bound that publishes nothing, never
a coverage knob). The same bytes under the same constants yield the same root
on any machine. A document holds one permit of the shared admission gate for
its whole duration, and one codec instance lives exactly as long as its
document.

### Annotations we define

`org.opencontainers.*` is reserved by the spec; ours are reverse-DNS under
`ai.lloyal`.

| key | meaning |
|---|---|
| `ai.lloyal.role` | `representation` (what the model saw) or `source` (as supplied) |
| `ai.lloyal.derive.*` | the parameters a representation was derived **under** |

Normalization is parameterized — pixel ceiling, quality — so one source under
two settings yields different pixels. Addressing the *derived* bytes and
recording what derived them is what keeps a replay exact after the
configuration changes. Retaining the source is what permits re-deriving later
— a better sampler, or a model that reads the original natively — and
omitting it is a legitimate choice for a large original.

## Admission

`createContentIngress` sniffs the bytes: an image goes to the policy below, a
PDF to the document ingress above, anything else is refused at the door.
For images, `ingest` (and `normalizeImage` underneath it) applies one policy.
Byte-identical pass-through happens only when ALL of these hold:

| | |
|---|---|
| format | one the projector decodes |
| size | under the pixel ceiling (default 4,194,304 px — the projector's own) |
| dimensions | known — read from the header when sharp cannot decode the file |
| EXIF orientation | identity (`1`) |
| colour | no ICC profile, or an sRGB one |

Anything else is **derived** — re-encoded as JPEG, downscaled to the ceiling,
orientation applied to the pixels, profile stripped — with the original
retained as the `source` layer. The result is always `jpeg`/`png`/`gif`/`bmp`.
An image that passes all five comes back untouched and is never degraded
twice.

The last two axes exist because the projector loads through `stb_image`, which
has no EXIF handling and ignores ICC entirely. A tag left on a pass-through is
a tag nothing downstream reads — so a portrait phone photo small enough to
skip the ceiling would reach the model sideways. Orientation is therefore
applied to pixels at admission, whatever the size.

What admission buys: **wire bytes** (~73% on a large photo at the default
ceiling), **format conversion** (webp/heic/tiff arrive from real users; the
projector reads none of them), and failures that happen **at the door, with
the file named** — before anything is committed or any branch of the run has
state to lose. At the default ceiling it does not change what the model sees:
the ceiling is the projector's own, so admission performs the projector's
downscale earlier. Below the default the ceiling becomes a fidelity dial.

**Known limit:** a non-sRGB profile forces derivation and derivation strips
the profile, so every admitted representation carries one consistent
interpretation — but the pixels are not converted. sharp/libvips performs no
ICC transform (measured), and neither does anything downstream.

Admission is also where content is inspected **before** it is addressed,
which is why images need no staging area — the payload fits in memory. Video
is exactly where that stops being true (see *Deferred*).

## Two invariants

**`index.json` is a catalogue, never the runtime authority.** Resolution goes
straight to `blobs/<algorithm>/<encoded>`; nothing on the replay path reads
the index. A lost concurrent index update can hide an attachment from OCI
tooling — it can never invalidate a recorded run.

**Write order is blobs → manifest → index.** A crash can leave orphan blobs,
which are harmless and unreferenced. It can never leave a committed manifest
pointing at content that is not there.

## Deferred

| | |
|---|---|
| **OCI Distribution** | The layout is already pushable by the mature Go CLIs. A client of our own waits until content must move between placements. |
| **Resumable ingress** (tus) | Appears when a payload outgrows memory — as an adapter in front of this store, not a change to it. Untrusted bytes stage, get inspected, and only then are admitted. |
| **Video derivation** | The manifest already has the slot: source + N frame representations. What is missing is a decoder, and that decision carries real licensing and codec-patent weight. |
| **Live capture** | The *locator* is not addressable; every bounded frame that reaches the model still is. Attachments are per-prefill rather than per-run, so a live run is many prefills — no growing manifest. |
| **Reachability GC** | Nothing here deletes. Deletion needs refcounting across runs that may share a digest. |
| **Rendering past the bound** | A page beyond `MAX_RENDERED_PAGES` has no render descriptor. Rendering on demand needs the source and a codec at read time; today a document is archived at admission only. |

## Known limitations

- **`index.json` is a mutable shared root**, updated read-modify-write.
  Writes are synchronous, so concurrent sessions inside one process serialize
  safely; two *processes* writing one layout can lose an index entry — a loss
  of discoverability, bounded by the first invariant above. Blobs are
  unaffected: content-addressed, written temp-then-rename.
- **`skopeo` is untested.** It is container-image tooling and is entitled to
  reject an artifact manifest whose config is not an image config. `oras` is
  the artifact-native tool and is the one the conformance suite drives.
