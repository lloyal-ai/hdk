# Embedding comparison

How well each embedding model in the catalog orders text, and what it costs. Each candidate embeds the frozen
reranker fixtures (`eval/rerank/fixtures.json`: 16 queries over 40 candidate chunks of the docs each, BM25 hits
plus random extras) through rig's own `createEmbedder`, with the reasoning model and its projector resident and
the reranker bound beside them, as a research harness has them.

**Relevance** is measured against the reranker's verdicts on the same fixtures (`scores-post-n10.json`), the
judge the abilities already trust: `recall@10` is how many of the judge's top five a model puts in its top ten;
`spearman` is rank correlation with the judge over all forty. **Latency** is per text, queries and documents
alike. **Memory** is the process's peak RSS while the encoder works, over the resident baseline.

Each candidate runs as rig's catalog binds it, with its pooling and its card's framing. The script says only
what a text is (the question is a query, each chunk a document for search, titled by its heading) and the
encoder writes the model's own framing: nomic's `search_query: ` and `search_document: ` prefixes, Qwen's
`Instruct: ...\nQuery:` line before a query and nothing before a document, EmbeddingGemma 2's
`task: search result | query: ` and `title: <heading> | text: `.

```
node eval/embedding/compare.mjs --candidates <dir> --resident <project>/models   # writes results.json
node eval/embedding/compare.mjs --candidates <dir> --no-resident                  # the encoders alone
```

`--candidates` is a directory holding `nomic-embed-text-v1.5.Q4_K_M.gguf`, `Qwen3-Embedding-0.6B-Q8_0.gguf` and
`embeddinggemma-2-Q8_0.gguf`;
`--resident` is a research project's `models/` tree (`llm/`, `vision/`, `reranker/`, one GGUF each), the system
the encoder is measured beside. The script refuses, naming the flag, when either is missing.

## Run of 2026-10-22

Baseline RSS 4.00 GB with the llm (qwen3.5-4b, 8192 context, 5 sequences) and its projector resident; Apple
M2 Pro, Metal, the native runtime built from the local checkout.

| model                             | dim  | load   | per text | +RSS    | recall@10 of judge top-5 | spearman |
| --------------------------------- | ---- | ------ | -------- | ------- | ------------------------ | -------- |
| `nomic-embed-text-v1.5-q4` (mean) | 768  | 87 ms  | 22.0 ms  | 0.29 GB | 0.525                    | 0.471    |
| `qwen3-embedding-0.6b-q8` (last)  | 1024 | 747 ms | 76.9 ms  | 0.71 GB | 0.612                    | 0.420    |
| `embeddinggemma-2-q8` (mean)      | 768  | 461 ms | 37.7 ms  | 1.26 GB | 0.512                    | 0.369    |

By query kind (recall@10 / spearman): vague: nomic 0.32 / 0.43, Qwen 0.48 / 0.31, EmbeddingGemma 2 0.40 / 0.31;
refined: 0.77 / 0.59, 0.77 / 0.59, 0.63 / 0.53; hard: 0.70 / 0.57, 0.90 / 0.61, 0.90 / 0.58; absent: 0.27 / 0.24,
0.33 / 0.14, 0.20 / 0.00.

**What changed since the first run.** The framing now comes from the catalog. nomic's numbers are exactly the
first run's, so the catalog writes what the script used to. Qwen's recall moved from 0.600 to 0.612 because its
query line now ends `Query:` with no space, as its card writes it. EmbeddingGemma 2 without titles (every
chunk `title: none`) scored 0.512 and 0.362: the heading as title is worth 0.007 of rank correlation here. The
+RSS column for nomic reads 0.29 GB where the first run read 0.08 GB, unexplained; peak RSS over a baseline
is a coarse measure.

**Reading.** On text alone, over these docs, EmbeddingGemma 2 is not the better text encoder: it matches Qwen
on hard queries and trails both on refined and absent ones, at half Qwen's latency and with the largest
footprint. Its case is the one this eval does not measure, one space for text, images, video and sound, and
on that case it is the default embedding model: a harness that indexes what it sees and what it hears searches
both with one model. nomic stays in the catalog for a harness that embeds text alone at the least cost.

## Run of 2026-09-25

Baseline RSS 3.82 GB with the llm (qwen3.5-4b, 8192 context, 5 sequences) and its projector resident.

| model                             | dim  | load   | per text | +RSS    | recall@10 of judge top-5 | spearman |
| --------------------------------- | ---- | ------ | -------- | ------- | ------------------------ | -------- |
| `nomic-embed-text-v1.5-q4` (mean) | 768  | 68 ms  | 22.7 ms  | 0.08 GB | 0.525                    | 0.471    |
| `qwen3-embedding-0.6b-q8` (last)  | 1024 | 871 ms | 87.9 ms  | 0.73 GB | 0.600                    | 0.421    |

By query kind (recall@10 / spearman): vague — nomic 0.32 / 0.43, Qwen 0.48 / 0.31; refined — 0.77 / 0.59 both;
hard — nomic 0.70 / 0.57, Qwen 0.80 / 0.62; absent — nomic 0.27 / 0.24, Qwen 0.33 / 0.15.

**What the first run taught.** Qwen scored 0.363 recall until the tokenizer was fixed: the runtime's default
`tokenize(text)` adds a leading special token where the model wants one and never the trailing one, although
this GGUF declares `add_eos_token = true`. Last-token pooling therefore read the last word, not
`<|endoftext|>`. The embedder now tokenizes with the model's declared special tokens (`addSpecial: true`);
nomic carried its `[CLS]`/`[SEP]` either way.

**Reading.** Qwen finds more of what the judge would confirm, most visibly on vague, one-word queries; nomic
orders the long tail more like the judge and costs a quarter of the latency and a tenth of the memory. On an
edge box holding a 4B model, a projector and the reranker, 0.65 GB is the difference between one resident
session and two.
