# @lloyal-labs/timeline-ability

Turns documents and transcripts into a **cited chronology** — every row carries
the span it came from, so a reader can open the page rather than take the model's
word for it.

```sh
npx lloyal-ai install lloyal/timeline
```

## What it returns

| | |
|---|---|
| `rows` | dated events, each assertion carrying its supporting span and page |
| `unresolved` | events it could not date — recorded, never guessed |
| `unprocessed` | segments that failed — visible, never dropped |

Partial dates stay partial: `"March 2024"` resolves to `2024-03`, never
`2024-03-01`. Two sources disagreeing produce two assertions, not one consensus.

## Configure

```ts
yield* store.set('timeline', {
  locale: 'en-GB',                    // REQUIRED — see below
  criteria: 'Only decisions, notices and statutory deadlines.',
});
```

`locale` has no default on purpose. `03/04/24` is 3 April under `en-GB` and
4 March under `en-US`, and a chronology silently wrong by a year is worse than
one that refuses to start.

`criteria` is your domain's definition of an event. A casework harness means
something different by it than a tax harness, and this package has no business
guessing which.

## Tool

`build_timeline({ documents })` — takes `EvidenceDocument`s (text plus
character-span → page/speaker regions) and returns the result above.

## Honest floor

- On evidence that fits one context, a prompt is likely cheaper and better.
- Dates are computed, never guessed: an expression the parser only partly
  understands goes to `unresolved` rather than becoming a confident wrong row.
- Slice 1 does not yet reconcile across documents or judge whether a cited span
  supports its claim.

Protocol: `timeline_chronology`.
