/**
 * What a root IS, learned from its manifest through the content plane: a
 * picture, or a document with its sidecar. One resolution per digest for the
 * page's lifetime — content is immutable under its address, so an answer never
 * goes stale. A root whose manifest cannot be read is shown as an image, so
 * the failure is visible (a broken picture) rather than silent.
 *
 * @category UI
 */
import { useEffect, useState } from 'react';
import { asDocumentMeta, configUrl, DOCUMENT_CONFIG_TYPE, manifestUrl } from '@lloyal-labs/media';
import type { DocumentMeta } from '@lloyal-labs/media';
import { useContentOrigin } from './provider.js';

export type Asset =
  | { kind: 'image' }
  | { kind: 'document'; meta: DocumentMeta; /** The ingest retained the original file. */ source: boolean };

const resolved = new Map<string, Promise<Asset>>();

export async function resolveAsset(origin: string, digest: string): Promise<Asset> {
  try {
    const manifest = (await (await fetch(manifestUrl(origin, digest))).json()) as {
      config?: { mediaType?: string };
      layers?: { annotations?: Record<string, string> }[];
    };
    if (manifest.config?.mediaType !== DOCUMENT_CONFIG_TYPE) return { kind: 'image' };
    const meta = asDocumentMeta(await (await fetch(configUrl(origin, digest))).json());
    if (!meta) return { kind: 'image' };
    const source = (manifest.layers ?? []).some((l) => l.annotations?.['ai.lloyal.role'] === 'source');
    return { kind: 'document', meta, source };
  } catch {
    return { kind: 'image' };
  }
}

/** The kinds of the given roots, filled in as the content plane answers. */
export function useAssets(digests: readonly string[]): Record<string, Asset> {
  const origin = useContentOrigin();
  const [assets, setAssets] = useState<Record<string, Asset>>({});
  const key = digests.join(' ');
  useEffect(() => {
    if (origin === null) return;
    let live = true;
    for (const digest of key ? key.split(' ') : []) {
      let p = resolved.get(digest);
      if (!p) {
        p = resolveAsset(origin, digest);
        resolved.set(digest, p);
      }
      void p.then((asset) => {
        if (live) setAssets((prev) => (prev[digest] ? prev : { ...prev, [digest]: asset }));
      });
    }
    return () => { live = false; };
  }, [origin, key]);
  return assets;
}

/** "1, 2, 3, 7" with runs of three or more folded: "1–3, 7". */
export function pageList(pages: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(j - i >= 2 ? `${pages[i]}–${pages[j]}` : pages.slice(i, j + 1).join(', '));
    i = j + 1;
  }
  return out.join(', ');
}

/** What of a document reached the model, page by page: which pages had no text
 *  to extract (scanned), which were extracted as text, and — when the thread
 *  holds their renders — which pages the model looked at. */
export function pageFacts(meta: DocumentMeta, viewedRenders: ReadonlySet<string> = new Set()): string[] {
  const scanned = meta.pages.filter((p) => p.chars === 0).map((p) => p.page);
  const viewed = meta.pages.filter((p) => p.render && viewedRenders.has(p.render.digest)).map((p) => p.page);
  const n = meta.pageCount;
  const lines = [
    scanned.length === 0
      ? `Extracted as text: all ${n} page${n === 1 ? '' : 's'}`
      : scanned.length === n
        ? `Scanned (image only): all ${n} page${n === 1 ? '' : 's'}`
        : `Scanned: ${pageList(scanned)} · extracted as text: the rest`,
  ];
  if (viewed.length > 0) lines.push(`Viewed as images: ${pageList(viewed)}`);
  return lines;
}
