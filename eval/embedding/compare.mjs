/**
 * Embedding comparison — how well each embedding model in the catalog orders text, and what it costs.
 *
 * Each candidate embeds the FROZEN reranker fixtures (16 queries × 40 candidate chunks of the docs) through
 * rig's own embedding provider, with the reasoning model, its projector and the reranker resident beside them,
 * as a research harness would have them. Relevance is measured against the reranker's verdicts on the same
 * fixtures — the judge the abilities already trust — so the question answered is "does this encoder find what
 * the judge would confirm": recall@10 of the reranker's top five, and Spearman rank correlation over all forty.
 * Latency is per text; memory is the process's peak RSS while the encoder works, over the resident baseline.
 *
 *   node eval/embedding/compare.mjs --candidates <dir> --resident <project>/models   # writes results.json
 *   node eval/embedding/compare.mjs --candidates <dir> --no-resident
 *
 * `--candidates` holds each candidate's GGUFs, the model and any projector, under the names the mirror keeps them
 * by; `--resident` is a research project's `models/` tree
 * (`llm/`, `vision/`, `reranker/`), the system the encoder is measured beside.
 *
 * Loaded with `require`, not `import`: rig is CommonJS and holds Effection's CommonJS build, and an `import`
 * from this module would take the ESM build — a second module instance in the process. One graph, one `run`.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createContext } = require('@lloyal-labs/lloyal.node');
const { catalogEntry, createReranker, providers } = require('@lloyal-labs/rig/node');
const { run } = require('effection');

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const RESIDENT = !argv.includes('--no-resident');
const candidates = flag('--candidates');
const residentDir = flag('--resident');
const usage = 'usage: node eval/embedding/compare.mjs --candidates <dir> (--resident <project>/models | --no-resident)';
if (!candidates || !existsSync(candidates)) { process.stderr.write(`${usage}\n--candidates: a directory holding the candidate GGUFs\n`); process.exit(1); }
if (RESIDENT && !(residentDir && existsSync(residentDir))) { process.stderr.write(`${usage}\n--resident: a project's models/ tree, or pass --no-resident\n`); process.exit(1); }

/** The one GGUF in a slot of the resident project's models tree. */
const slot = (role) => {
  const dir = resolve(residentDir, role);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.gguf')) : [];
  if (files.length !== 1) { process.stderr.write(`--resident: expected one .gguf in ${dir}, found ${files.length}\n`); process.exit(1); }
  return resolve(dir, files[0]);
};
const resident = RESIDENT ? { llm: slot('llm'), mmproj: slot('vision'), reranker: slot('reranker') } : null;

const fixtures = JSON.parse(readFileSync(resolve(root, 'eval/rerank/fixtures.json'), 'utf8'));
const verdicts = JSON.parse(readFileSync(resolve(root, 'eval/rerank/scores-post-n10.json'), 'utf8'));

/** A catalog id's file, by the name its mirror keeps it under, in the candidates directory. */
const fileOf = (role, id) => resolve(candidates, basename(new URL(catalogEntry(role, id).urls.at(-1)).pathname));

/** Each candidate is bound through rig's own embedding provider, as a harness whose block names that id binds it:
 *  the projector it pairs, the context its entry gives, its pooling, and its card's framing, which the encoder
 *  writes from what the eval says of a text (a query, or a document for search, titled by its heading), never
 *  from a prefix written here. */
const MODELS = ['nomic-embed-text-v1.5-q4', 'embeddinggemma-2-q8'].map((id) => {
  const block = { id };
  const paired = providers.embedding.projector.select(block);
  return { id, block, path: fileOf('embedding', id), ...(paired ? { projector: fileOf('embedding.projector', paired.id) } : {}) };
});
for (const file of MODELS.flatMap((m) => [m.path, m.projector].filter(Boolean))) {
  if (!existsSync(file)) { process.stderr.write(`--candidates: ${file} is not there\n`); process.exit(1); }
}

const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const rankOf = (scores) => { const order = scores.map((s, i) => [s, i]).sort((x, y) => y[0] - x[0]); const r = new Array(scores.length); order.forEach(([, i], pos) => { r[i] = pos; }); return r; };
const spearman = (a, b) => { const n = a.length; const ra = rankOf(a), rb = rankOf(b); let d2 = 0; for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2; return 1 - (6 * d2) / (n * (n * n - 1)); };
const rss = () => process.memoryUsage().rss;
const gb = (b) => `${(b / 1024 ** 3).toFixed(2)} GB`;

const verdictOf = new Map(verdicts.results.map((r) => [r.id, r]));
const out = { ranAt: new Date().toISOString(), resident: RESIDENT, models: [] };

const held = [];
if (resident) {
  process.stdout.write('loading the resident system: llm + projector + reranker …\n');
  held.push(await createContext({ modelPath: resident.llm, nCtx: 8192, nSeqMax: 5, mmprojPath: resident.mmproj }));
}
const baseline = rss();
process.stdout.write(`baseline rss ${gb(baseline)}\n`);

for (const m of MODELS) {
  const result = await run(function* () {
    if (resident) yield* createReranker(resident.reranker, { nCtx: 16384 });
    const before = rss();
    const t0 = performance.now();
    const e = yield* providers.embedding.bind(m.path, m.block, m.projector);
    const loadMs = performance.now() - t0;
    let peak = rss();
    const per = [];
    let texts = 0, textMs = 0, refused = 0;
    for (const q of fixtures.queries) {
      const v = verdictOf.get(q.id);
      // A chunk's heading is its title: a model whose card frames titled documents reads it, the others ignore it.
      const docs = q.candidates.map((c) => ({ parts: [c.text], title: c.heading }));
      const t1 = performance.now();
      let vectors;
      try { vectors = yield* e.embed([{ parts: [q.text], role: 'query' }, ...docs]); }
      catch (err) { refused++; process.stderr.write(`${m.id} ${q.id}: ${err.message}\n`); continue; }
      textMs += performance.now() - t1; texts += docs.length + 1;
      peak = Math.max(peak, rss());
      const [qv, ...dv] = vectors;
      const sims = dv.map((d) => cosine(qv, d));
      const judge = q.candidates.map((_, i) => v.scores[String(i)]);
      const judgeTop5 = rankOf(judge).map((r, i) => [r, i]).filter(([r]) => r < 5).map(([, i]) => i);
      const mineTop10 = new Set(rankOf(sims).map((r, i) => [r, i]).filter(([r]) => r < 10).map(([, i]) => i));
      per.push({ id: q.id, kind: q.kind, recallAt10: judgeTop5.filter((i) => mineTop10.has(i)).length / judgeTop5.length, spearman: spearman(sims, judge) });
    }
    const mean = (k) => per.reduce((s, p) => s + p[k], 0) / per.length;
    return { id: m.id, dimension: e.dimension, loadMs: Math.round(loadMs), msPerText: +(textMs / texts).toFixed(1), texts, refused, recallAt10: +mean('recallAt10').toFixed(3), spearman: +mean('spearman').toFixed(3), rssLoad: peak - before, per };
  });
  out.models.push(result);
  process.stdout.write(`${result.id}: dim ${result.dimension} · load ${result.loadMs} ms · ${result.msPerText} ms/text over ${result.texts} · refused ${result.refused} · recall@10 of judge top-5 ${result.recallAt10} · spearman ${result.spearman} · +rss ${gb(result.rssLoad)}\n`);
}
writeFileSync(resolve(__dirname, 'results.json'), JSON.stringify(out, null, 2));
for (const h of held) h.dispose?.();
process.stdout.write(`written eval/embedding/results.json\n`);
