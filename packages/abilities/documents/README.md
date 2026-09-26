# @lloyal-labs/documents-ability

**Give your agents the documents the user attached.**

HDK Ability `lloyal/documents` — a PDF attached to the conversation becomes searchable passages with page numbers, readable sections, and page images an agent can look at when a table or chart matters. Retrieval is the corpus stack: BM25 first stage, cross-encoder rerank, honest scores. Evidence is cited by content address, so a page an agent quotes opens in the UI at the exact bytes the run used.

| Tool | What agents get |
| --- | --- |
| `search_documents` | Passages ranked by the reranker, each with its document, heading, line range, pages and a `cite` URL |
| `read_document` | The exact text of a page or a line range — the verification step after search |
| `view_page` | The page (or one figure on it) as an image, for tables and charts; text-only pages say so |

Protocol: `document_research` · Documents reach the ability as the assets available to a run (`ToolContext.attachments`) and are indexed once per digest. The table of contents is published via `Source.promptData(attachments)` for spine placement. Distributed through the signed channel.
