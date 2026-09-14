/** The IPC channel names the shell and the preload agree on — importable without `electron`. */
export const CHANNELS = { event: 'harness:event', command: 'harness:command', snapshot: 'harness:snapshot' } as const;
