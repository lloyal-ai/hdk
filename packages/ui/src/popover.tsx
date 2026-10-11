/**
 * A small surface anchored to a control, floated over the page through a
 * portal so no ancestor's clipping, filter or stacking order can trap it.
 * It opens above its anchor, closes on Escape or a press outside, and hands
 * focus back to the anchor when it goes. What it contains is the caller's.
 *
 * @category UI
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** What a keyboard can land on: every native control, and anything that opted in. */
const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export interface PopoverProps {
  /** The control the surface belongs to; its rectangle places the surface and its focus is restored on close. */
  anchor: HTMLElement | null;
  open: boolean;
  onClose(): void;
  /** What the surface is, for assistive technology. */
  label: string;
  children: ReactNode;
  /** The caller's register over the defaults. */
  style?: CSSProperties;
}

const MARGIN = 8;

const surface: CSSProperties = {
  position: 'fixed', zIndex: 60, minWidth: 220, maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
  padding: 6, borderRadius: 12, boxSizing: 'border-box',
  background: 'var(--harness-bg, #FFFFFF)', color: 'var(--harness-fg, #17171B)',
  border: '1px solid var(--harness-rule, #EDEDF0)', boxShadow: '0 8px 28px rgba(20,20,30,.14)',
  font: '13px var(--harness-font, system-ui, sans-serif)',
};

/** Where the surface sits: above the anchor, left-aligned with it, pulled in from the viewport's right edge. */
function place(anchor: HTMLElement, width: number): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN));
  return { left, bottom: window.innerHeight - rect.top + MARGIN };
}

export function Popover({ anchor, open, onClose, label, children, style }: PopoverProps): ReactElement | null {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ left: MARGIN, bottom: MARGIN });

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const node = panel.current;
    const measure = (): void => setPosition(place(anchor, node?.offsetWidth ?? 0));
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    const onPress = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (target && (node?.contains(target) || anchor.contains(target))) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress);
    // Focus lands on the first control of any native kind; a surface with none takes it itself.
    (node?.querySelector<HTMLElement>(FOCUSABLE) ?? node)?.focus();
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress);
      anchor.focus();
    };
  }, [open, anchor, onClose]);

  if (!open || !anchor) return null;
  return createPortal(
    <div ref={panel} role="dialog" aria-label={label} tabIndex={-1} style={{ ...surface, ...position, ...style }}>
      {children}
    </div>,
    document.body,
  );
}
