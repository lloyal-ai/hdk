/**
 * The microphone reaches the app's own windows after the operating system says yes, and nothing
 * else reaches anything: a foreign page, a camera, a standing refusal all come back as no. A
 * standing refusal is explained in the window and the setting is opened only when asked for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  status: 'not-determined' as 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown',
  asked: 0,
  answer: true,
  opened: [] as string[],
  shown: [] as { parent: unknown; message: string; detail: string; buttons: string[] }[],
  choice: 0,
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: (contents: { id: number }) => ({ window: contents.id }) },
  dialog: {
    showMessageBox: (...args: unknown[]) => {
      const [parent, options] = args.length === 2 ? args : [null, args[0]];
      const o = options as { message: string; detail: string; buttons: string[] };
      electron.shown.push({ parent, message: o.message, detail: o.detail, buttons: o.buttons });
      return Promise.resolve({ response: electron.choice, checkboxChecked: false });
    },
  },
  shell: { openExternal: (url: string) => { electron.opened.push(url); return Promise.resolve(); } },
  systemPreferences: {
    getMediaAccessStatus: () => electron.status,
    askForMediaAccess: () => { electron.asked++; return Promise.resolve(electron.answer); },
  },
}));

import { allowMicrophone, microphoneConsent, prepareMicrophone } from '../src/microphone';
import type { Session, WebContents } from 'electron';

type Check = Parameters<Session['setPermissionCheckHandler']>[0];
type Request = Parameters<Session['setPermissionRequestHandler']>[0];

function fakeSession() {
  const handlers: { check?: Check; request?: Request } = {};
  const session = {
    setPermissionCheckHandler: (h: Check) => { handlers.check = h; },
    setPermissionRequestHandler: (h: Request) => { handlers.request = h; },
  } as unknown as Session;
  return { session, handlers };
}

const ours = { id: 1 } as unknown as WebContents;
const theirs = { id: 2 } as unknown as WebContents;

const ask = (handlers: { request?: Request }, contents: WebContents, permission: string, details: object = {}) =>
  new Promise<boolean>((resolve) => handlers.request!(contents, permission as never, resolve, details as never));

const onPlatform = async (value: string, body: () => Promise<void>): Promise<void> => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value });
  try { await body(); } finally { Object.defineProperty(process, 'platform', platform); }
};
const onDarwin = (body: () => Promise<void>): Promise<void> => onPlatform('darwin', body);

/** The first frame on the wire, as the engine sends it: config, and whether this boot is a dev boot. */
const configFrame = (dictates: boolean, dev: boolean) =>
  ({ type: 'config:loaded', config: { model: dictates ? { transcription: { id: 'asr' } } : { llm: { id: 'x' } } }, dev });

afterEach(() => { Object.assign(electron, { status: 'not-determined', asked: 0, answer: true, opened: [], shown: [], choice: 0 }); });

describe('the microphone from a desktop window', () => {
  it('reaches an owned window for audio once consent is given, and nothing else', async () => {
    const { session, handlers } = fakeSession();
    const consent = vi.fn(async () => true);
    allowMicrophone(session, (c) => c === ours, consent);
    expect(await ask(handlers, ours, 'media', { mediaTypes: ['audio'] })).toBe(true);
    expect(consent).toHaveBeenCalledExactlyOnceWith(ours);
    expect(await ask(handlers, ours, 'media', { mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(await ask(handlers, theirs, 'media', { mediaTypes: ['audio'] })).toBe(false);
    expect(await ask(handlers, ours, 'geolocation')).toBe(false);
    expect(consent).toHaveBeenCalledOnce();
    expect(handlers.check!(ours, 'media', 'file://', { mediaType: 'audio' } as never)).toBe(true);
    expect(handlers.check!(ours, 'media', 'file://', { mediaType: 'video' } as never)).toBe(false);
    expect(handlers.check!(ours, 'media', 'file://', {} as never)).toBe(false);
    expect(handlers.check!(theirs, 'media', 'file://', { mediaType: 'audio' } as never)).toBe(false);
    expect(handlers.check!(null, 'media', 'file://', { mediaType: 'audio' } as never)).toBe(false);
    expect(handlers.check!(ours, 'notifications', 'file://', {} as never)).toBe(false);
  });

  it('answers a refused consent, or a consent that throws, with no', async () => {
    const { session, handlers } = fakeSession();
    allowMicrophone(session, () => true, async () => false);
    expect(await ask(handlers, ours, 'media', { mediaTypes: ['audio'] })).toBe(false);
    allowMicrophone(session, () => true, async () => { throw new Error('no answer'); });
    expect(await ask(handlers, ours, 'media', { mediaTypes: ['audio'] })).toBe(false);
  });

  it('prompts once while undecided, remembers a yes, and is unconditional off macOS', async () => {
    await onDarwin(async () => {
      expect(await microphoneConsent(ours)).toBe(true);
      expect(electron.asked).toBe(1);
      electron.status = 'granted';
      expect(await microphoneConsent(ours)).toBe(true);
      expect(electron.asked).toBe(1);
      expect(electron.shown).toEqual([]);
    });
    await onPlatform('linux', async () => {
      electron.status = 'denied';
      expect(await microphoneConsent(ours)).toBe(true);
      expect(electron.shown).toEqual([]);
    });
  });

  it('asks at launch on a dev boot, once, when the first config frame says the harness dictates', async () => {
    await onDarwin(async () => {
      const contents = () => ours;
      prepareMicrophone(configFrame(true, false), contents);
      await Promise.resolve();
      expect(electron.asked).toBe(0);
      prepareMicrophone({ type: 'agent:tick' }, contents);
      prepareMicrophone(configFrame(false, true), contents);
      expect(electron.asked).toBe(0);
      prepareMicrophone(configFrame(true, true), contents);
      await Promise.resolve();
      expect(electron.asked).toBe(1);
      prepareMicrophone(configFrame(true, true), contents);
      await Promise.resolve();
      expect(electron.asked).toBe(1);
    });
  });

  it('explains a standing refusal in the window and opens the setting only when asked', async () => {
    await onDarwin(async () => {
      electron.status = 'denied';
      electron.choice = 1;
      prepareMicrophone(configFrame(true, false), () => ours);
      expect(await microphoneConsent(ours)).toBe(false);
      expect(electron.shown).toHaveLength(1);
      expect(electron.shown[0].parent).toEqual({ window: 1 });
      expect(electron.shown[0].message).toBe('Microphone access is off for this app');
      expect(electron.shown[0].detail).toContain('Privacy & Security');
      expect(electron.shown[0].detail).not.toContain('terminal');
      expect(electron.opened).toEqual([]);
      electron.choice = 0;
      prepareMicrophone(configFrame(true, true), () => ours);
      electron.shown.length = 1;
      const env = { TERM_PROGRAM: process.env.TERM_PROGRAM, npm_lifecycle_event: process.env.npm_lifecycle_event };
      process.env.TERM_PROGRAM = 'Apple_Terminal';
      process.env.npm_lifecycle_event = 'dev:desktop';
      try {
        expect(await microphoneConsent(ours)).toBe(false);
      } finally {
        process.env.TERM_PROGRAM = env.TERM_PROGRAM;
        process.env.npm_lifecycle_event = env.npm_lifecycle_event;
      }
      expect(electron.shown[1].detail).toContain('listed there as Terminal');
      expect(electron.shown[1].detail).toContain('quit and reopen it, which stops this app');
      expect(electron.shown[1].detail).toContain('run npm run dev:desktop again');
      expect(electron.opened).toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone']);
    });
  });
});
