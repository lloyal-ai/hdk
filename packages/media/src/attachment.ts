/**
 * @file The OCI shapes an attachment is made of.
 *
 * Pure data and pure functions — no filesystem, no `node:` anything — so the
 * consumers that only need to NAME an attachment (`trace-types.ts`,
 * `replay.ts`, `agent-pool.ts`) do not pull a Node store into their module
 * graph. Mirrors `trace-types.ts` beside `trace-writer.ts`.
 *
 * **The on-disk format is the OCI Image Layout**, and conformance is the point
 * — not inspiration. A directory written under these shapes is a valid OCI
 * artifact store that `oras`, `crane` and `skopeo` can push to any registry
 * with no client of ours in the path. See `packages/media/README.md` for the
 * format, the annotations we define, and the conformance notes.
 */

/** The OCI media type of an image manifest — what an attachment manifest IS.
 *
 *  Named because two places state it: the {@link AttachmentManifest} type and
 *  the store that writes the field. A literal in both is a literal that can
 *  drift, and they live in different files now. */
export const MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json' as const;

/**
 * An OCI content descriptor — a pointer to one blob.
 *
 * Conforms to image-spec `descriptor.md`: `mediaType`, `digest` and `size` are
 * required and `annotations` is the OPTIONAL free-form map. Field ORDER is
 * irrelevant to conformance but digest form is not — `<algorithm>:<encoded>`.
 *
 * @category Media
 */
export interface Descriptor {
  mediaType: string;
  /** `sha256:<64 hex>` — algorithm-prefixed, as OCI writes it. */
  digest: string;
  size: number;
  annotations?: Record<string, string>;
}

/**
 * OCI's canonical empty blob — content `{}`, two bytes.
 *
 * An artifact manifest still REQUIRES a `config`, so the spec defines this to
 * fill the slot when an artifact has no config of its own. The digest is
 * fixed by the spec; it is not computed.
 *
 * @category Media
 */
export const EMPTY_DESCRIPTOR: Descriptor = {
  mediaType: 'application/vnd.oci.empty.v1+json',
  digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  size: 2,
};

/** What `artifactType` declares these manifests to be — the reverse-DNS name
 *  that lets any OCI reader tell our artifacts from container images. */
export const ATTACHMENT_ARTIFACT_TYPE = 'application/vnd.lloyal.attachment.v1';

/**
 * A digest in the only form this store writes or accepts.
 *
 * Exported because the shape is an OCI FORMAT rule, not a transport rule — an
 * HTTP route validating a digest is enforcing this, not a policy of its own,
 * and a second regex elsewhere is a second place to get it wrong.
 *
 * @category Media
 */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Which part a layer plays. `org.opencontainers.*` is reserved by the spec,
 *  so ours are reverse-DNS under `ai.lloyal`. */
export const ROLE_ANNOTATION = 'ai.lloyal.role';
/** Prefix for the parameters a representation was derived UNDER. */
export const DERIVE_PREFIX = 'ai.lloyal.derive.';

/**
 * One attachment, as an OCI artifact manifest.
 *
 * The indirection is the whole design. An image today is one representation
 * and maybe a source; a video is a source plus N sampled frames; a live
 * capture is frames with no source. Because the fold and the replay path hold
 * a pointer to THIS rather than to a blob, each of those is an additive change
 * here and invisible above it.
 *
 * `layers` carries every blob belonging to the attachment, each tagged by
 * {@link ROLE_ANNOTATION}: `representation` for what actually entered the
 * cache, `source` for what the user supplied. Retaining a source is what
 * permits re-derivation later — a better sampler, or a model that reads video
 * natively — and omitting it is a legitimate choice for a large original.
 *
 * **Derivation parameters live on each representation** ({@link DERIVE_PREFIX})
 * and that is a correctness requirement, not provenance. Normalization is
 * parameterized — pixel ceiling, quality, the projector's token budget — so
 * one source under two settings yields different pixels and therefore
 * different KV. Addressing the derived bytes and recording what derived them
 * is what stops a replay under changed config from silently rebuilding a
 * different cache state.
 *
 * @category Media
 */
export interface AttachmentManifest {
  schemaVersion: 2;
  mediaType: typeof MANIFEST_TYPE;
  artifactType: typeof ATTACHMENT_ARTIFACT_TYPE;
  config: Descriptor;
  layers: Descriptor[];
  annotations?: Record<string, string>;
}

declare const ROOT: unique symbol;

/**
 * A reference to an attachment: the descriptor of its {@link AttachmentManifest}.
 *
 * **Branded, so an attachment is not interchangeable with any other
 * descriptor.** It was a bare alias, and the design's central rule — an
 * attachment references a MANIFEST, never a blob — rested on nobody making the
 * mistake. That rule has already been broken once here: a replay guard
 * compared marker count against ATTACHMENT count while the code below it
 * flattened each manifest's REPRESENTATIONS, so one two-frame video threw
 * before it could be rebuilt. Both quantities were `Descriptor[]`, and nothing
 * could have told them apart.
 *
 * The brand is a type-level phantom — `declare const` emits nothing — so an
 * `Attachment` is still a plain descriptor at runtime and widens to
 * {@link Descriptor} for free. Narrowing the other way is deliberate: only a
 * store that just composed and committed the manifest may assert it.
 *
 * @category Media
 */
export type Attachment = Descriptor & { readonly [ROOT]: true };

/**
 * Narrow an untrusted descriptor to an attachment root, or refuse it.
 *
 * The ONE way a `Descriptor` becomes an `Attachment` outside a store that just
 * committed one — and it exists because there is now a boundary that needs it:
 * a browser uploads over the content plane, gets a root back, and sends it in
 * a command. That descriptor arrives as JSON from a client, so it is a CLAIM
 * about content, not a fact about it.
 *
 * Checks only what a descriptor can be judged on by itself: a well-formed
 * digest, and a media type that says it points at a manifest. Whether the
 * manifest is actually THERE is not a question a type can answer —
 * `materialize` asks the store and throws if it is not, which is the check
 * that matters and the one that cannot be forged. A digest is identity, never
 * authorization.
 *
 * @category Media
 */
export function asAttachment(d: Descriptor): Attachment | null {
  return DIGEST_PATTERN.test(d.digest) && d.mediaType === MANIFEST_TYPE
    ? (d as Attachment)
    : null;
}

/** The layers that entered the cache, in marker order — what replay needs. */
export function representationsOf(m: AttachmentManifest): Descriptor[] {
  return m.layers.filter(l => l.annotations?.[ROLE_ANNOTATION] !== 'source');
}

/** The original the representations were derived from, when it was retained. */
export function sourceOf(m: AttachmentManifest): Descriptor | undefined {
  return m.layers.find(l => l.annotations?.[ROLE_ANNOTATION] === 'source');
}

/**
 * Assemble a conformant manifest from semantic parts.
 *
 * MODULE-INTERNAL: {@link commitManifest} is the only way to make one from
 * outside, because composing a manifest WITHOUT writing its config blob is
 * exactly the conformance bug, and a public pure composer is an invitation to
 * do that. Kept separate from the commit sequence because it is the one part
 * that touches no store — what an attachment manifest IS, as opposed to how it
 * is committed.
 *
 * `null` when there is no representation: `layers` must hold at least one
 * descriptor to be valid, and an attachment with nothing that reached the
 * cache is meaningless anyway.
 */
export function composeManifest(parts: {
  representations: readonly Descriptor[];
  source?: Descriptor;
  config: Descriptor;
  annotations?: Record<string, string>;
}): AttachmentManifest | null {
  if (parts.representations.length === 0) return null;
  const tag = (d: Descriptor, role: string): Descriptor => ({
    ...d,
    annotations: { ...(d.annotations ?? {}), [ROLE_ANNOTATION]: role },
  });
  return {
    schemaVersion: 2,
    mediaType: MANIFEST_TYPE,
    artifactType: ATTACHMENT_ARTIFACT_TYPE,
    config: parts.config,
    layers: [
      ...parts.representations.map(r => tag(r, 'representation')),
      ...(parts.source ? [tag(parts.source, 'source')] : []),
    ],
    ...(parts.annotations ? { annotations: parts.annotations } : {}),
  };
}

/**
 * Commit an attachment: config blob, then manifest, in that order.
 *
 * The whole sequence, parameterized only by HOW bytes are stored — which is
 * the sole real difference between a filesystem store and an in-memory one.
 * `putAttachment`'s body was byte-identical in both before this, so the rules
 * below were rules each store happened to follow rather than rules the format
 * enforces, and a third store would have had to rediscover them:
 *
 * 1. **The config blob is WRITTEN, never merely named.** A puller fetches it
 *    like any other blob, so a manifest referencing OCI's canonical empty
 *    descriptor without storing `{}` looks correct locally and fails
 *    everywhere else. This is the conformance trap `verify:oci` gives its own
 *    check; it is also the step with no local consequence, which is exactly
 *    why it is the one that gets dropped.
 * 2. **Blobs first, manifest second.** A crash may leave orphan blobs —
 *    harmless, unreferenced, content-addressed — but never a committed
 *    manifest pointing at content that is not there.
 * 3. **An attachment needs a representation.** `layers` must hold at least one
 *    descriptor to be valid, and an attachment where nothing reached the cache
 *    is meaningless anyway.
 *
 * The representation and source blobs are written by the CALLER before this,
 * for reason 2 — they are the content; this commits the record of it.
 *
 * @param putBlob - The store's one primitive. Throws on failure, like every
 *                  write in this contract.
 * @throws If there is no representation, or any write fails.
 *
 * @category Media
 */
export function commitManifest(
  putBlob: (bytes: Uint8Array, mediaType: string) => Descriptor,
  parts: {
    representations: readonly Descriptor[];
    source?: Descriptor;
    config?: { bytes: Uint8Array; mediaType: string };
    annotations?: Record<string, string>;
  },
): Attachment {
  if (parts.representations.length === 0) {
    throw new Error(
      'commitManifest: no representation. A manifest needs at least one layer ' +
        'to be valid, and an attachment where nothing reached the cache is ' +
        'meaningless.',
    );
  }
  const enc = new TextEncoder();
  // Written either way. For the empty case the descriptor is the canonical
  // constant rather than the write's return, so the manifest names exactly
  // what every other OCI tool expects to find.
  const config = parts.config
    ? putBlob(parts.config.bytes, parts.config.mediaType)
    : (putBlob(enc.encode('{}'), EMPTY_DESCRIPTOR.mediaType), EMPTY_DESCRIPTOR);

  const manifest = composeManifest({ ...parts, config });
  if (!manifest) {
    // Unreachable: the only null case is the empty-representations one, refused
    // above. Kept so a future rule added to composeManifest cannot pass here.
    throw new Error('commitManifest: composeManifest refused these parts.');
  }
  return putBlob(enc.encode(JSON.stringify(manifest)), MANIFEST_TYPE) as Attachment;
}
