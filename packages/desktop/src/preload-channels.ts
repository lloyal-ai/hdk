/** The IPC channel names the shell and the preload agree on — importable without `electron`. */
export const CHANNELS = {
  event: 'harness:event',
  command: 'harness:command',
  snapshot: 'harness:snapshot',
  /** Main pushes each {@link SessionState} change here. */
  session: 'harness:session',
  /** …and answers with the current one here, so a renderer that loads mid-session is not left guessing. */
  sessionNow: 'harness:session-now',
  /** The reader asking for a working engine. Main owns what that means. */
  recover: 'harness:recover',
  /** …and what is being acquired right now, for a renderer that loaded after the install began — or after a
   *  refusal ended the engine. Same shape as `sessionNow`, for the same reason. */
  installNow: 'harness:install-now',
  /** …and what a subscriber that arrives late must be told first: the latest of each snapshot-shaped platform
   *  frame, so a view that mounts after the harness has spoken folds from the start, not the middle. */
  bootstrap: 'harness:bootstrap',
  /** The reader choosing a local file; main opens the system dialog and answers the path, or null if they
   *  cancelled. */
  chooseFile: 'harness:choose-file',
} as const;
