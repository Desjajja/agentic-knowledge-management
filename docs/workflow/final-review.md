# AKM workflow v2 final implementation review

Historical engineering review before API-restored validation. For completed restored experiments and the exact source-id prompt clarification, see `docs/workflow/restored-run-review.md` and `docs/workflow-v2-validation.md`. The quota-blocked status below describes that earlier run, not the current experiment status.

Reviewed 2026-10-13 against `docs/akm-next-iteration-design.md`, the baseline `/tmp/akm-workflow-v2-before`, and the final working implementation. Implementation review was read-only; this report is the only file written. Reviewed the final test code and `/tmp/akm-v2-tests-final.txt`, which now records 44 passed, 0 failed; did not rerun the suite.

## Assessment

The important issues from the interim review are addressed for the tested sequential workflows. Project selection is validated, merge relations resolve through the common canonicalizer, evidence supplementation is restricted to one tool call/round, provider declarations are removed for the final round, normal CLI model workflows save cumulative run records, and complete extraction prompts receive a documented conservative estimate before requests. Supplement budget reporting has also been corrected. Concurrent identical source processing remains a scope limitation rather than an achieved contract.

This is approval of the reviewed engineering changes within the sequential-processing scope, not a finding that the real-model quality or performance acceptance gates have passed. Fresh English `artifacts/workflow-v2-benchmark-2026-10-13/manual-evaluation.json` records 7 correct, 4 partial and 5 failed cases against the unchanged frozen corpus, including its known fencing distortion. Chinese and A/B/C completion were blocked again by provider quota. Earlier `artifacts/workflow-v2-2026-10-12` also contains failed scenarios and A/B/C runs; its `evaluation-complete.json` only records execution completion and cannot establish success. Do not count failed/402 requests as passed quality cases or use them as completed A/B/C performance samples.

## Remaining findings

### Fixed: supplemental section budget accounting

Location: `src/pi-tools.js:18` and `src/pi-tools.js:38`.

Verified the final implementation captures the initial supplement allowance, subtracts both query passages and section reads, and reports `limit`, `used`, unit and exhaustion from the resulting shared counter. Search snippets are now sliced and charged to that same allowance. The prior P2 budget finding is closed.

### Known scope limitation: source idempotency is sequential, not concurrent

Location: `src/pi.js:144` and `src/pi.js:246`.

The cache lookup and cache publication occur on opposite sides of an unlocked asynchronous extraction/reconciliation run. Two identical uploads that start before either publishes the cache both miss it, call the model, and persist distinct proposals; the last cache write wins. Atomic commit preconditions prevent silent overwrites, but do not prevent duplicate extraction cost or duplicate pending proposals. This matters because external processes can call the same Vault independently and the design describes source-hash reuse as deterministic idempotency.

The final delivery scopes this implementation to sequential retry idempotency; callers must serialize identical source processing. Concurrent identical misses remain deferred. A future implementation should reserve processing per source key under the Vault lock, with in-progress state and failure/stale recovery, and test concurrent calls before advertising concurrent idempotency.

## Interim findings and final checks

| Interim issue | Final result |
|---|---|
| Repeated/unbounded supplements | Addressed: one tool call and one tool-enabled round, shared remaining passage-character budget; final provider payload strips tool declarations. Aggregate and search budget reporting now include all returned original text. |
| Uncoordinated chunk drafts | Addressed: bounded reconciliation groups account for every draft exactly once; cross-project/different-update-target groups are rejected; deterministic metadata/source union follows model body reconciliation. Exact targets also consolidate. |
| Model changes requested project | Addressed by returned-item validation before proposal creation. |
| Merge leaves path/wiki references dangling | Addressed by common link resolution before discarded states change. Stable survivor labels, deterministic source union and original expected hashes remain intact. |
| CLI drops cost ledger | Addressed for actual model runs by `.akm/runs` callbacks and task aggregation. Missing provider usage is null; known usage is separate. Zero-request early returns/preflight failures currently produce no run file. |
| Oversized complete input prompt | Addressed for extraction/reconciliation with a clearly labeled estimate and oversized-conversation rejection. This remains an estimate, not proof for every tokenizer or content type. |
| Text serialized twice to model | Addressed by `evidenceForModel`, which removes compatibility content/snippets when passages carry the text. |
| No stable document source locations | Addressed by original paragraph/split-part ids and offsets; supplied ids are validated. Missing ids are explicitly marked as processed-chunk fallback. |

Two issues identified during final re-review are also fixed: raw draft support ids are normalized before reconciliation so mixed selected/fallback supports survive, and answer results now include supplemental evidence even without a caller trace callback. Corresponding regression tests inspect preserved support spans and citations to newly discovered evidence. `processingComplete` is correctly accompanied by `claimCoverageVerified: false`; it does not establish semantic completeness.

Hash checks reject changing evidence during discovery/read and again before final answers. Citation checking rejects undiscovered wiki-link paths. It does not prove factual support or require the exact display alias; those remain quality-review concerns. Source qualifier/comparator heuristics are intentionally incomplete and must not be treated as a proof of faithful natural-language rewriting.

## Validation limits

The 44-test log supports protocol and deterministic workflow behavior, including real SDK calls to controlled endpoints. It does not establish quality from a real model. Final-answer protocol rejection now catches unexecuted DSML/tool-call output, in addition to removing tool declarations and adding an explicit final-answer instruction after supplementation. Such rejected responses are failures, not successful answers. The fresh artifact results show that quality gates are not achieved; successful repeated/interleaved Chinese and A/B/C samples are still needed for performance assessment and must include explicit failed-sample accounting.
