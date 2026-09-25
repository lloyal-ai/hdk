/**
 * Embedding comparison — the gate on the catalog's default embedding model.
 *
 * Both candidates embed the FROZEN reranker fixtures (16 queries × 40 candidate chunks of the docs) through
 * rig's own `createEmbedder`, with the reasoning model, its projector and the reranker resident beside them,
 * as a research harness would have them. Relevance is measured against the reranker's verdicts on the same
 * fixtures — the judge the abilities already trust — so the question answered is "does this encoder find what
 * the judge would confirm": recall@10 of the reranker's top five, and Spearman rank correlation over all forty.
 * Latency is per text; memory is the process's peak RSS while the encoder works, over the resident baseline.
 *
 *   node eval/embedding/compare.mjs [--no-resident]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const args = new Set(process.argv.slice(2));
const RESIDENT = !args.has('--no-resident');

const NODE = pathToFileURL(resolve(root, 'node_modules/@lloyal-labs/lloyal.node/dist/index.js')).href;
const RIG = pathToFileURL(resolve(root, 'packages/rig/dist/node.js')).href;
const EFFECTION = pathToFileURL("/Users/zuhairnaqvi/dev/apps/lloyal-sdk/node_modules/effection/script/mod.js").href;
const { createContext } = await import(NODE);
const { createEmbedder, createReranker } = await import(RIG);
const { run } = await import(EFFECTION);

const fixtures = JSON.parse(readFileSync(resolve(root, 'eval/rerank/fixtures.json'), 'utf8'));
const verdicts = JSON.parse(readFileSync(resolve(root, 'eval/rerank/scores-post-n10.json'), 'utf8'));
const resident = {
  llm: resolve(homedir(), 'dev/apps/casework/e2e-0923-research/models/llm/qwen3.5-4b.gguf'),
  mmproj: resolve(homedir(), 'dev/apps/casework/e2e-0923-research/models/mmproj/qwen3.5-4b-mmproj.gguf'),
  reranker: resolve(homedir(), 'dev/apps/casework/e2e-0923-research/models/reranker/qwen3-reranker-0.6b-q8.gguf'),
};

/** Each candidate prepares its text the way its card says: the encoder never guesses which side a text is. */
const MODELS = [
  {
    id: 'nomic-embed-text-v1.5-q4', pooling: 'mean', nCtx: 2048,
    path: resolve(homedir(), 'dev/apps/lloyal-node/models/nomic-embed-text-v1.5.Q4_K_M.gguf'),
    query: (q) => `search_query: ${q}`, doc: (d) => `search_document: ${d}`,
  },
  {
    id: 'qwen3-embedding-0.6b-q8', pooling: 'last', nCtx: 2048,
    path: resolve(homedir(), 'dev/apps/lloyal-node/models/Qwen3-Embedding-0.6B-Q8_0.gguf'),
    query: (q) => `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ${q}`, doc: (d) => d,
  },
];

const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const rankOf = (scores) => { const order = scores.map((s, i) => [s, i]).sort((x, y) => y[0] - x[0]); const r = new Array(scores.length); order.forEach(([, i], pos) => { r[i] = pos; }); return r; };
const spearman = (a, b) => { const n = a.length; const ra = rankOf(a), rb = rankOf(b); let d2 = 0; for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2; return 1 - (6 * d2) / (n * (n * n - 1)); };
const rss = () => process.memoryUsage().rss;
const gb = (b) => `${(b / 1024 ** 3).toFixed(2)} GB`;

const verdictOf = new Map(verdicts.results.map((r) => [r.id, r]));
const out = { ranAt: new Date().toISOString(), resident: RESIDENT, models: [] };

const held = [];
if (RESIDENT) {
  process.stdout.write('loading the resident system: llm + projector + reranker …\n');
  held.push(await createContext({ modelPath: resident.llm, nCtx: 8192, nSeqMax: 5, mmprojPath: resident.mmproj }));
}
const baseline = rss();
process.stdout.write(`baseline rss ${gb(baseline)}\n`);

for (const m of MODELS) {
  const result = await run(function* () {
    if (RESIDENT) yield* createReranker(resident.reranker, { nCtx: 16384 });
    const before = rss();
    const t0 = performance.now();
    const e = yield* createEmbedder(m.path, { nCtx: m.nCtx, pooling: m.pooling });
    const loadMs = performance.now() - t0;
    let peak = rss();
    const per = [];
    let texts = 0, textMs = 0, refused = 0;
    for (const q of fixtures.queries) {
      const v = verdictOf.get(q.id);
      const docs = q.candidates.map((c) => m.doc(c.text));
      const t1 = performance.now();
      let vectors;
      try { vectors = yield* e.embed([m.query(q.text), ...docs]); }
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
