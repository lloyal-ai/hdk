# Lloyal working context

## Shared knowledge

- [Engineering principles](https://linear.app/lloyal/document/engineering-principles-7ce0944c48b3)
- [Architecture and project knowledge](https://linear.app/lloyal/document/architecture-and-project-knowledge-b7c3375f9525)
- [Working agreements](https://linear.app/lloyal/document/working-agreements-6495e1c0504e)
- [liblloyal architecture and existing primitives](https://linear.app/lloyal/document/liblloyal-architecture-and-existing-primitives-b42e4fc089b8)

These documents live in the Linear Lloyal Platform project. Read the relevant document when working in its area; the essential rules below remain available without Linear. Follow the owner's latest instructions and use live repository contents for current implementation, versions, licensing, and release state. Historical plans do not reactivate old tasks.

## Programming style

- Prefer declarative, self-documenting code written for humans to read.
- Express intent through clear names, data, and small, composable operations.
- DRY and composition over creation are critical: identify and compose existing primitives before adding machinery; extend the smallest owning boundary when a capability is missing.
- Avoid dense imperative control flow, nested `if`/`else` chains, and nested loops; make the rules and transformations explicit.
- Make the code understandable from its structure without depending on lengthy comments. Comments provide durable context, constraints, rationale or invariants for a code reader, never transient task status, session notes or implementation chronology.
- Public-facing documentation and comments must not contain internal links. Keep internal planning and progress in Linear; public material should stand on its own for an outside reader.
- Judge abstractions by how clearly they communicate intent; moving complexity behind helpers or into a dense expression does not improve readability by itself.

## Native context boundary

- All native-context access from other `packages/*` must go through `packages/sdk`.
- Keep native binding details behind the SDK's public API. Add missing capabilities at that boundary instead of bypassing it in a consumer.
- The Node binding repository is `../lloyal-node`; its sibling submodules are `../lloyal-node/liblloyal` and `../lloyal-node/llama.cpp`. Trace SDK behavior through those implementations when changing the native contract.
- Existing bypasses are migration work, not precedent for new ones.
- Preserve native ownership, admission/accounting, and failure semantics. In-flight native work must settle before its state is pruned or disposed.

## Guiding principle

Invest in simplification up front. Build from genuinely simple, independent parts so future changes require less work. Evaluate a design by how readily it can be understood and changed.

Rich Hickey's *Simplicity Matters* is the explicit influence. The full owner-supplied passage is preserved in Engineering principles.

## Working agreements

- Read the relevant implementation, tests, instructions, and current diff before changing code. Keep changes targeted and preserve unrelated user work.
- All package and application layers must have clear responsibilities. Keep native details out of UI; compose reusable mechanics in their owning packages.
- Verify the behavior affected by the change. Distinguish source inspection, typechecks, automated tests, real-model runs, and measurements in reports.
- Integration tests, locally and in CI, must use their intended models: SmolLM2 for text, Qwen3.5-4B with its vision projector for image projection and strict multimodal checks, Qwen3-ASR with its audio projector for audio, and the designated embedding model for embeddings. Run model-specific suites in separate processes with explicit selections. Never use text-only SmolLM for multimodal tests or weaken grounded image assertions with a mechanics-only substitute.
- For local Node/SDK native runtime tests, set `LLOYAL_LOCAL=1` and verify package resolution reaches the intended local Node checkout. Direct C++ integration runners bypass that loader switch; verify their include paths and linked local engine artifacts instead.
- Preserve approved public wording and design. Explain factual corrections; avoid em dashes in new public copy and unrequested README rewrites.
- Do not push, merge, tag, release, or publish without authorization for the current task. Honor authorization already given without repeated permission requests, and follow applicable repository requirements for commits and PRs.
- Keep changing facts dated and sourced. A merge alone is not proof of a published release.
