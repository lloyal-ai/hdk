/**
 * Where a played video opens: at its cited moment, for either player. One rule,
 * so Video.js's player and the browser's own cannot drift.
 *
 * @category UI
 */
import { useEffect } from 'react';
import type { RefObject } from 'react';

/** Open at `atMs`: at once when the media already knows its length, else when it learns it. A new moment of
 *  the same file seeks too, since a loaded file fires no second `loadedmetadata`. */
export function useStartAt(media: RefObject<HTMLVideoElement | null>, atMs: number | undefined, src: string): void {
  useEffect(() => {
    const element = media.current;
    if (!element || atMs === undefined) return;
    const seek = (): void => { element.currentTime = atMs / 1000; };
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
    else element.addEventListener('loadedmetadata', seek, { once: true });
    return () => element.removeEventListener('loadedmetadata', seek);
  }, [media, atMs, src]);
}
