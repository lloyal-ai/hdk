# Embedding comparison

The gate on which embedding model the catalog puts first. Two candidates embed the frozen reranker fixtures
(`eval/rerank/fixtures.json`: 16 queries over 40 candidate chunks of the docs each, BM25 hits plus random
extras) through rig's own `createEmbedder`, with the reasoning model and its projector resident and the
reranker bound beside them, as a research harness has them.

**Relevance** is measured against the reranker's verdicts on the same fixtures (`scores-post-n10.json`), the
judge the abilities already trust: `recall@10` is how many of the judge's top five a model puts in its top ten;
`spearman` is rank correlation with the judge over all forty. **Latency** is per text, queries and documents
alike. **Memory** is the process's peak RSS while the encoder works, over the resident baseline.

Each candidate prepares its text the way its model card says, because the encoder never guesses which side a
text is: nomic takes `search_query: ` / `search_document: ` prefixes; Qwen takes an `Instruct: … \nQuery: …`
line for the query and bare documents.

```
node eval/embedding/compare.mjs --candidates <dir> --resident <project>/models   # writes results.json
node eval/embedding/compare.mjs --candidates <dir> --no-resident                  # the encoders alone
```

`--candidates` is a directory holding `nomic-embed-text-v1.5.Q4_K_M.gguf` and `Qwen3-Embedding-0.6B-Q8_0.gguf`;
`--resident` is a research project's `models/` tree (`llm/`, `vision/`, `reranker/`, one GGUF each), the system
the encoder is measured beside. The script refuses, naming the flag, when either is missing.

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
