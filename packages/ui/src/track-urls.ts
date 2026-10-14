/**
 * A video's tracks as files a `<track>` element can load, for any player:
 * Video.js's and the browser's own read the same WebVTT.
 *
 * @category UI
 */
import { useEffect, useState } from 'react';
import { videoTracks } from './video-view.js';
import type { VideoView } from './video-view.js';

export type TrackUrls = { thumbnails: string; captions?: string; chapters?: string };

/**
 * Each track's WebVTT as a `blob:` URL (a page's CSP admits `blob:` media).
 * Made by the effect that lets them go, so every setup revokes only its own:
 * under StrictMode, which sets effects up, tears them down and sets them up
 * again, the tracks point at the second setup's live files. Null until then.
 */
export function useTrackUrls(view: VideoView): TrackUrls | null {
  const [urls, setUrls] = useState<TrackUrls | null>(null);
  useEffect(() => {
    const url = (vtt: string): string => URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    const tracks = videoTracks(view, document.baseURI);
    const made: TrackUrls = {
      thumbnails: url(tracks.thumbnails),
      ...(tracks.captions ? { captions: url(tracks.captions) } : {}),
      ...(tracks.chapters ? { chapters: url(tracks.chapters) } : {}),
    };
    setUrls(made);
    return () => Object.values(made).forEach((u) => URL.revokeObjectURL(u));
  }, [view]);
  return urls;
}
