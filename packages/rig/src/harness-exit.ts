/**
 * A one-shot run the harness could not proceed past: its message is the
 * diagnosis, its exit code the verdict. The boot writes the message to stderr
 * and exits with the code; an interactive harness never throws it.
 *
 * @category Rig
 */
export class HarnessExit extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = 'HarnessExit';
  }
}
