/**
 * The full-size view of one asset: a single image by its root, or a PDF in
 * the browser's own viewer. One enlarged view for a whole app — the figure
 * strip, a run bar's marker and a cited page in the prose all open this one,
 * so there is one that cannot drift. Escape and a click on the scrim close it.
 *
 * @category UI
 */
import { useEffect } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { representationUrl } from '@lloyal-labs/media';
import { useContentOrigin } from './provider.js';

const short = (digest: string): string => digest.replace(/^sha256:/, '').slice(0, 10);

export interface LightboxProps {
  /** The root of a single image to show — a photo, a page render. */
  digest?: string;
  /** Or a PDF to open in the browser's own viewer: the URL the content plane serves the original at. */
  pdf?: string;
  /** The representation's true pixel size, when the caller read it off the loaded element. */
  dims?: string;
  /** What is being shown, when it is not simply "the attached image". */
  label?: string;
  onClose: () => void;
  /** The caller's register: the scrim, the image and the caption. */
  styles?: { scrim?: CSSProperties; full?: CSSProperties; pdf?: CSSProperties; caption?: CSSProperties };
}

const S: Required<NonNullable<LightboxProps['styles']>> = {
  scrim: {
    position: 'fixed', inset: 0, zIndex: 50, cursor: 'zoom-out', background: 'rgba(20,20,22,.82)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32,
  },
  full: { maxWidth: '100%', maxHeight: 'calc(100vh - 110px)', objectFit: 'contain', borderRadius: 12, background: '#fff' },
  pdf: { width: 'min(1100px, 94vw)', height: 'calc(100vh - 110px)', border: 0, borderRadius: 12, background: '#fff' },
  caption: { font: '12px system-ui, sans-serif', color: '#D8D8D2', margin: 0 },
};

export function Lightbox({ digest, pdf, dims, label, onClose, styles = {} }: LightboxProps): ReactElement | null {
  const origin = useContentOrigin();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (origin === null) return null;
  const s = { ...S, ...styles };
  if (pdf !== undefined) {
    return (
      <div style={s.scrim} role="dialog" aria-modal="true" aria-label={label ?? 'Attached document'} onClick={onClose}>
        <iframe src={pdf} title={label ?? 'Attached document'} style={s.pdf} onClick={(e) => e.stopPropagation()} />
        <p style={s.caption}>{label ?? 'the attached document'} · the file as attached</p>
      </div>
    );
  }
  if (digest === undefined) return null;
  return (
    <div style={s.scrim} role="dialog" aria-modal="true" aria-label={label ?? 'Attached image, full size'} onClick={onClose}>
      <img src={representationUrl(origin, digest)} alt={label ?? 'Attached image, as the model received it'} style={s.full} />
      <p style={s.caption}>
        {label ?? 'what the model saw'}{dims ? ` · ${dims}` : ''} · {short(digest)}
      </p>
    </div>
  );
}
