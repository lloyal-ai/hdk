# @lloyal-labs/corpus-app

**Give your agents a knowledge base they can actually read.**

HDK App `lloyal/corpus` — point it at a directory of documents and agents get ranked semantic search, exhaustive grep, and verbatim file reads over it. Two-stage retrieval: BM25 lexical first stage over the full corpus, cross-encoder rerank for the semantics, honest scores (log-odds of a yes/no relevance judgment) so agents know when the corpus *doesn't* have the answer.

```bash
npx harness.dev install lloyal/corpus
```

| Tool | What agents get |
| --- | --- |
| `search` | Top-K chunks ranked by the reranker, with files, headings, line ranges, scores |
| `grep` | Every regex match across the corpus, exhaustive, with line numbers |
| `read_file` | Verbatim file content by line range — the verification step after search |

Protocol: `corpus_research` · The corpus table of contents is published via `Source.promptData()` for spine placement. Distributed through the signed channel at `apps.lloyal.ai`.
