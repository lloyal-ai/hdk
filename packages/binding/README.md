# @lloyal-labs/binding

The harness's **headless interface** — the event/command binding and its transports.

A harness exposes its work through an `EventBus<WorkflowEvent>` (events *down*) and a
command dispatch (commands *up*). That pair is its headless interface; a **binding** is
a *transport* of it. This package owns the generic binding — the bus, the wire frame,
the mode selector, and the Node transports — so "one harness, many placements" is real
rather than copy-pasted.

- **`@lloyal-labs/binding`** — `createBus`, `EventBus<T>`, `BindingFrame<E, C>` (isomorphic).
- **`@lloyal-labs/binding/node`** — `selectMode`, `bindHeadless` (the `jsonl` and
  `parentPort`-else-`fork` transports).

Ink (in-process) stays app-side; this package owns the headless transports. The `wss`
transport (`./web`) is reserved.
