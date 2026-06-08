import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from '../command';
import { ensureFreshToken } from '../cf-access-oauth';

const API_BASE = 'https://api.lloyal.ai';
const REVIEW_BASE = `${API_BASE}/v1/review`;

const USAGE = [
  'harness.dev review — Lloyal-internal review surface for pending app submissions',
  '',
  'Usage:',
  '  npx harness.dev review list [--status pending|approved|rejected] [--limit N]',
  '  npx harness.dev review inspect <submissionId> [--extract <dir>]',
  '  npx harness.dev review approve <submissionId>',
  '  npx harness.dev review reject  <submissionId> --reason "<text>"',
  '',
  'Subcommands:',
  '  list      List submissions in the given status (default `pending`).',
  '  inspect   Show the manifest stub for a submission; with --extract, also',
  '            download the tarball into the given directory.',
  '  approve   Approve a pending submission — Worker signs the tarball, writes',
  '            canonical R2, and updates the signed catalog.',
  '  reject    Reject a pending submission with a free-text reason. Pending',
  '            artifacts are preserved for 30 days (appeals window).',
  '',
  'Auth: same Cloudflare Access OAuth flow as the rest of the CLI. The Worker',
  'enforces `@lloyal.ai` SSO on every endpoint here — non-staff identities get 403.',
].join('\n');

export const reviewCommand: Command = {
  name: 'review',
  summary: 'Lloyal-internal review surface for pending app submissions',
  usage: USAGE,
  async run(argv) {
    const sub = argv[0];
    if (!sub || sub === '-h' || sub === '--help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const rest = argv.slice(1);
    switch (sub) {
      case 'list':
        return runList(rest);
      case 'inspect':
        return runInspect(rest);
      case 'approve':
        return runApprove(rest);
      case 'reject':
        return runReject(rest);
      default:
        process.stderr.write(`harness.dev review: unknown subcommand "${sub}"\n\n${USAGE}\n`);
        return 1;
    }
  },
};

interface ReviewSubmissionSummary {
  submissionId: string;
  publisherHandle: string;
  publisherEmail: string;
  name: string;
  version: string;
  importName: string;
  submittedAt: string;
  tarballSize: number;
  status: string;
  approvedAt?: string;
  rejectedAt?: string;
  reviewerEmail?: string;
  rejectionReason?: string;
}

async function runList(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      help: { type: 'boolean', short: 'h' },
      status: { type: 'string' },
      limit: { type: 'string' },
      cursor: { type: 'string' },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const status = values.status ?? 'pending';
  if (status !== 'pending' && status !== 'approved' && status !== 'rejected') {
    process.stderr.write(
      `harness.dev review list: invalid --status "${status}" (expected pending|approved|rejected)\n`,
    );
    return 1;
  }
  const url = new URL(`${REVIEW_BASE}/list`);
  url.searchParams.set('status', status);
  if (values.limit) url.searchParams.set('limit', values.limit);
  if (values.cursor) url.searchParams.set('cursor', values.cursor);

  const res = await authedGet(url.toString());
  if (!res.ok) return errorOut('review list', res);
  const body = (await res.json()) as {
    submissions?: ReviewSubmissionSummary[];
    nextCursor?: string | null;
  };
  const submissions = body.submissions ?? [];
  if (submissions.length === 0) {
    process.stdout.write(`no submissions with status=${status}\n`);
  } else {
    for (const s of submissions) {
      const size = `${(s.tarballSize / 1024).toFixed(1)}KB`;
      process.stdout.write(
        `${s.submissionId}  ${s.name}@${s.version}  ${s.publisherHandle}  ${size}  ${s.submittedAt}\n`,
      );
    }
  }
  if (body.nextCursor) {
    process.stdout.write(`\nnextCursor: ${body.nextCursor}\n`);
  }
  return 0;
}

async function runInspect(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      help: { type: 'boolean', short: 'h' },
      extract: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write('harness.dev review inspect: expected exactly one <submissionId>\n');
    return 1;
  }
  const submissionId = positionals[0];

  const res = await authedGet(`${REVIEW_BASE}/inspect/${submissionId}`);
  if (!res.ok) return errorOut('review inspect', res);
  const body = (await res.json()) as {
    submission?: ReviewSubmissionSummary;
    manifestStub?: Record<string, unknown>;
    tarballInspectUrl?: string;
  };

  if (body.submission) {
    const s = body.submission;
    process.stdout.write(`${s.submissionId}\n`);
    process.stdout.write(`  name:           ${s.name}@${s.version}\n`);
    process.stdout.write(`  importName:     ${s.importName}\n`);
    process.stdout.write(`  publisher:      ${s.publisherHandle} (${s.publisherEmail})\n`);
    process.stdout.write(`  submittedAt:    ${s.submittedAt}\n`);
    process.stdout.write(`  status:         ${s.status}\n`);
    process.stdout.write(`  tarballSize:    ${s.tarballSize}\n`);
  }
  if (body.manifestStub) {
    process.stdout.write(`\nmanifest-stub:\n${JSON.stringify(body.manifestStub, null, 2)}\n`);
  }

  if (values.extract && body.tarballInspectUrl) {
    const outDir = resolve(values.extract);
    await mkdir(outDir, { recursive: true });
    const flatName =
      (body.submission?.name ?? submissionId).replace('/', '__') +
      '-' +
      (body.submission?.version ?? '0.0.0') +
      '.tgz';
    const outPath = join(outDir, flatName);
    const tgz = await authedGet(body.tarballInspectUrl);
    if (!tgz.ok) return errorOut('review inspect (tarball download)', tgz);
    const buf = new Uint8Array(await tgz.arrayBuffer());
    await writeFile(outPath, buf);
    process.stdout.write(`\ntarball: ${outPath} (${buf.byteLength} bytes)\n`);
  } else if (body.tarballInspectUrl) {
    process.stdout.write(
      `\ntarball URL: ${body.tarballInspectUrl}\n` +
        '  re-run with `--extract <dir>` to save it locally for hand-inspection.\n',
    );
  }
  return 0;
}

async function runApprove(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write('harness.dev review approve: expected exactly one <submissionId>\n');
    return 1;
  }
  const submissionId = positionals[0];

  const res = await authedFetch(`${REVIEW_BASE}/approve/${submissionId}`, {
    method: 'POST',
  });
  if (!res.ok) return errorOut('review approve', res);
  const body = (await res.json()) as {
    approved?: boolean;
    name?: string;
    version?: string;
    importName?: string;
    tarballUrl?: string;
    manifestUrl?: string;
    catalogSignedAt?: string;
    approvedAt?: string;
  };
  process.stdout.write(
    `approved ${body.name ?? '(unknown)'}@${body.version ?? '?'}\n` +
      (body.importName ? `  importName:   ${body.importName}\n` : '') +
      (body.tarballUrl ? `  tarball:      ${body.tarballUrl}\n` : '') +
      (body.manifestUrl ? `  manifest:     ${body.manifestUrl}\n` : '') +
      (body.catalogSignedAt
        ? `  catalog:      signedAt=${body.catalogSignedAt}\n`
        : '') +
      (body.approvedAt ? `  approvedAt:   ${body.approvedAt}\n` : ''),
  );
  return 0;
}

async function runReject(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      help: { type: 'boolean', short: 'h' },
      reason: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write('harness.dev review reject: expected exactly one <submissionId>\n');
    return 1;
  }
  if (typeof values.reason !== 'string' || values.reason.length < 3) {
    process.stderr.write('harness.dev review reject: --reason "<text>" (min 3 chars) is required\n');
    return 1;
  }
  const submissionId = positionals[0];

  const res = await authedFetch(`${REVIEW_BASE}/reject/${submissionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: values.reason }),
  });
  if (!res.ok) return errorOut('review reject', res);
  const body = (await res.json()) as {
    rejected?: boolean;
    rejectedAt?: string;
    rejectionReason?: string;
    reviewerEmail?: string;
  };
  process.stdout.write(
    `rejected ${submissionId}\n` +
      (body.rejectionReason ? `  reason:    ${body.rejectionReason}\n` : '') +
      (body.reviewerEmail ? `  reviewer:  ${body.reviewerEmail}\n` : '') +
      (body.rejectedAt ? `  at:        ${body.rejectedAt}\n` : ''),
  );
  return 0;
}

// ── Auth helpers ──────────────────────────────────────────────────

async function authedHeaders(endpoint: string): Promise<Record<string, string>> {
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (id && secret) {
    return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };
  }
  const token = await ensureFreshToken(endpoint);
  return { Authorization: `Bearer ${token}` };
}

async function authedGet(url: string): Promise<Response> {
  const headers = await authedHeaders(url);
  return fetch(url, { headers });
}

async function authedFetch(url: string, init: RequestInit): Promise<Response> {
  const headers = { ...(await authedHeaders(url)), ...(init.headers as Record<string, string> | undefined ?? {}) };
  return fetch(url, { ...init, headers });
}

async function errorOut(label: string, res: Response): Promise<number> {
  const body = await res.text();
  process.stderr.write(`harness.dev ${label}: HTTP ${res.status} ${res.statusText}\n${body}\n`);
  return 1;
}
