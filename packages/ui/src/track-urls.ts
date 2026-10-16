/**
 * A video's tracks as files a `<track>` element can load, for any player:
 * Video.js's and the browser's own read the same WebVTT.
 *
 * @category UI
 */
import { useEffect, useMemo, useState } from 'react';
import { videoTracks } from './video-view.js';
import type { VideoView } from './video-view.js';

export type TrackUrls = { thumbnails: string; captions?: string; chapters?: string };

/**
 * Each track's WebVTT as a `blob:` URL (a page's CSP admits `blob:` media).
 * Made by the effect that lets them go, so every setup revokes only its own:
 * under StrictMode, which sets effects up, tears them down and sets them up
 * again, the tracks point at the second setup's live files. Null until then.
 *
 * Kept for as long as the tracks say the same thing, not for as long as the
 * view is the same object: a caller that builds an equal view on every render
 * must not swap a playing video's tracks out from under it.
 *
 * On a server there is no page to resolve a frame's address against, so the
 * tracks keep their addresses as written; no file is made there either, since
 * the effect that makes them does not run.
 */
export function useTrackUrls(view: VideoView): TrackUrls | null {
  const [urls, setUrls] = useState<TrackUrls | null>(null);
  const { thumbnails, captions, chapters } = useMemo(
    () => videoTracks(view, typeof document === 'undefined' ? undefined : document.baseURI),
    [view],
  );
  useEffect(() => {
    const url = (vtt: string): string => URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    const made: TrackUrls = {
      thumbnails: url(thumbnails),
      ...(captions ? { captions: url(captions) } : {}),
      ...(chapters ? { chapters: url(chapters) } : {}),
    };
    setUrls(made);
    return () => Object.values(made).forEach((u) => URL.revokeObjectURL(u));
  }, [thumbnails, captions, chapters]);
  return urls;
}
