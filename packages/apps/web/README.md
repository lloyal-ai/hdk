# @lloyal-labs/web-app

**Give your agents the open web — no API key required.**

HDK App `lloyal/web` — live web search and page reading for any harness. Ships with a keyless search provider (rate-limit aware, with circuit breaker and parked retries) and optional Tavily when you have a key. Fetched pages are chunked and reranked against the agent's query, so agents read the relevant part, not the whole page.

```bash
npx harness.dev install lloyal/web
```

| Tool | What agents get |
| --- | --- |
| `web_search` | Ranked results with titles, URLs, snippets — keyless by default, Tavily if configured |
| `fetch_page` | A page's content, chunked and reranked against the query, top chunks verbatim |

Protocol: `web_research` · Transient backend rate limits never reach the model — the runtime parks and retries silently. Distributed through the signed channel at `apps.lloyal.ai`.
