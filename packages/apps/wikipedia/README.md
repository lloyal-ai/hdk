# @lloyal-labs/wikipedia-app

HDK reference app — Wikipedia research. Distributed as `lloyal/wikipedia` through the signed channel at `apps.lloyal.ai`. Install via `harness.dev install lloyal/wikipedia`.

## What it does

Wraps two public Wikipedia API endpoints — no auth, no keys — and exposes them as HDK tools any harness can register.

| Tool               | What it returns                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `wikipedia_search` | Up to 10 article titles + one-line descriptions + URLs, from MediaWiki's opensearch endpoint         |
| `wikipedia_fetch`  | An article's curated lead paragraph + extract + canonical URL, from the REST `page/summary` endpoint |

No reranker required; the source exposes structured Wikipedia content directly.

## Usage in a harness

```ts
import { createWikipediaApp } from "@lloyal-labs/wikipedia-app";
import { createAppRegistry } from "@lloyal-labs/rig";

const registry =
  yield *
  createAppRegistry({
    apps: { wikipedia: createWikipediaApp },
  });
```

That's the entire integration. Agents in the pool can now call `wikipedia_search` and `wikipedia_fetch` whenever the planner routes a subtask to this app.

## Why Wikipedia?

It's the reference "vertical API consumer" pattern — every app that wraps a third-party HTTP API follows roughly this shape (search → fetch → return structured content). The Wikipedia REST is a good demo because there's no setup and the API is famously stable.
