import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import type { Command } from '../command';
import { ensureFreshToken } from '../cf-access-oauth';

const API_BASE = 'https://api.lloyal.ai';
const REGISTER_ENDPOINT = `${API_BASE}/v1/publishers/register`;
const ME_ENDPOINT = `${API_BASE}/v1/publishers/me`;
const TOS_URL = 'https://docs.lloyal.ai/licensing/publisher-tos';

const CURRENT_TOS_VERSION = 'v1';

const USAGE = [
  'harness.dev publishers — manage your publisher account on apps.lloyal.ai',
  '',
  'Usage:',
  '  npx harness.dev publishers register --handle <handle> [--yes]',
  '  npx harness.dev publishers me',
  '',
  'Subcommands:',
  '  register   Claim a publisher handle + attest the publisher ToS.',
  '  me         Show the current authenticated identity\'s publisher record.',
  '',
  'Options (register):',
  '  --handle <handle>   The publisher handle to claim (matches `[a-z][a-z0-9_-]{1,63}`).',
  '                      First-come-first-served except `lloyal` (reserved). Handles',
  '                      published apps are namespaced under: `<handle>/<short-name>`.',
  '  --yes               Accept the publisher ToS without an interactive prompt. Required',
  '                      when running non-interactively. The CLI still prints the ToS URL.',
  '  -h, --help          Show this help',
  '',
  'Auth: interactive Cloudflare Access OAuth. Service Tokens cannot register;',
  'they\'re for CI automation against an already-registered identity.',
  '',
  'The publisher ToS is published at https://docs.lloyal.ai/licensing/publisher-tos.',
  'Registration is a one-time step per identity; subsequent ToS revisions require',
  're-attestation but the handle is retained.',
].join('\n');

export const publishersCommand: Command = {
  name: 'publishers',
  summary: 'Manage your publisher account on apps.lloyal.ai',
  usage: USAGE,
  async run(argv) {
    const sub = argv[0];
    if (!sub || sub === '-h' || sub === '--help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const rest = argv.slice(1);
    if (sub === 'register') return runRegister(rest);
    if (sub === 'me') return runMe(rest);
    process.stderr.write(`harness.dev publishers: unknown subcommand "${sub}"\n\n${USAGE}\n`);
    return 1;
  },
};

async function runRegister(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      help: { type: 'boolean', short: 'h' },
      handle: { type: 'string' },
      yes: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (typeof values.handle !== 'string' || values.handle.length === 0) {
    process.stderr.write('harness.dev publishers register: --handle <handle> is required\n');
    return 1;
  }
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(values.handle)) {
    process.stderr.write(
      `harness.dev publishers register: invalid handle "${values.handle}" — expected ` +
        '`[a-z][a-z0-9_-]{1,63}`.\n',
    );
    return 1;
  }

  // Service Tokens (CI) cannot register; require a TTY for the OAuth flow.
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    process.stderr.write(
      'harness.dev publishers register: Service Tokens cannot register publisher accounts. ' +
        'Register from an interactive session first; CI automation can then publish with ' +
        'a Service Token bound to the registered identity.\n',
    );
    return 1;
  }
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'harness.dev publishers register: stdin is not a TTY — interactive Cloudflare Access ' +
        'SSO is required for registration. Run from a terminal session.\n',
    );
    return 1;
  }

  process.stdout.write(
    `\nPublisher ToS (${CURRENT_TOS_VERSION}): ${TOS_URL}\n` +
      '\nBy registering you attest that you have read and accept the publisher Terms of Service.\n' +
      '\n',
  );

  if (!values.yes) {
    const accepted = await promptYesNo('Accept the publisher ToS? [y/N] ');
    if (!accepted) {
      process.stderr.write('harness.dev publishers register: ToS not accepted; aborting\n');
      return 1;
    }
  }

  let accessToken: string;
  try {
    accessToken = await ensureFreshToken(REGISTER_ENDPOINT);
  } catch (err) {
    process.stderr.write(`harness.dev publishers register: ${asMessage(err)}\n`);
    return 1;
  }

  const res = await fetch(REGISTER_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      handle: values.handle,
      tosAccepted: true,
      tosVersion: CURRENT_TOS_VERSION,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    handle?: string;
    registeredAt?: string;
    tosVersion?: string;
    error?: string;
    currentTosVersion?: string;
  };
  if (!res.ok) {
    process.stderr.write(
      `harness.dev publishers register: HTTP ${res.status} ${res.statusText}\n` +
        `  error: ${body.error ?? '(no error code)'}\n` +
        (body.currentTosVersion
          ? `  currentTosVersion: ${body.currentTosVersion}\n`
          : ''),
    );
    return 1;
  }
  process.stdout.write(
    `registered as ${body.handle ?? values.handle}\n` +
      `  tosVersion: ${body.tosVersion ?? CURRENT_TOS_VERSION}\n` +
      (body.registeredAt ? `  registeredAt: ${body.registeredAt}\n` : ''),
  );
  return 0;
}

async function runMe(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { help: { type: 'boolean', short: 'h' } },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let headers: Record<string, string>;
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (id && secret) {
    headers = { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };
  } else {
    try {
      const token = await ensureFreshToken(ME_ENDPOINT);
      headers = { Authorization: `Bearer ${token}` };
    } catch (err) {
      process.stderr.write(`harness.dev publishers me: ${asMessage(err)}\n`);
      return 1;
    }
  }

  const res = await fetch(ME_ENDPOINT, { headers });
  if (res.status === 404) {
    process.stderr.write(
      'harness.dev publishers me: no publisher account for this identity. ' +
        'Run `harness.dev publishers register --handle <handle>` first.\n',
    );
    return 1;
  }
  if (!res.ok) {
    const body = await res.text();
    process.stderr.write(`harness.dev publishers me: HTTP ${res.status}\n${body}\n`);
    return 1;
  }
  const me = (await res.json()) as {
    handle?: string;
    status?: string;
    publishedCount?: number;
    tosVersion?: string;
    tosAcceptedAt?: string;
    createdAt?: string;
  };
  process.stdout.write(`${me.handle ?? '(unknown)'}\n`);
  if (me.status) process.stdout.write(`  status:         ${me.status}\n`);
  if (typeof me.publishedCount === 'number')
    process.stdout.write(`  published:      ${me.publishedCount}\n`);
  if (me.tosVersion) process.stdout.write(`  tosVersion:     ${me.tosVersion}\n`);
  if (me.tosAcceptedAt) process.stdout.write(`  tosAcceptedAt:  ${me.tosAcceptedAt}\n`);
  if (me.createdAt) process.stdout.write(`  createdAt:      ${me.createdAt}\n`);
  return 0;
}

async function promptYesNo(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(message)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
