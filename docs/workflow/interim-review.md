# AKM workflow v2 interim independent review

Reviewed 2026-10-12 against `docs/akm-next-iteration-design.md` and `/tmp/akm-workflow-v2-before`. This is a read-only implementation review; only this report was written. Parent implementation and tests were still in progress. Findings refer to the implementation read during review, before follow-up fixes. No full suite was rerun.

The deterministic source union, stable survivor labels, atomic commits, update-context hashes, and null handling in `sumUsage` are useful foundations. Evidence tools reject hashes that change during a task, and project relation boundaries are enforced at commit. The issues below remain material to the approved workflow contract.

## Important findings

### 1. Task evidence and supplement budgets are not enforced

Locations: `src/pi-tools.js:15`, `src/pi-tools.js:45`, `src/pi.js:189`.

Each aggregate call receives a fresh default 24,000-character budget, and every `akm_read` independently permits another 8,000 characters. The model can make several calls in one assistant turn or repeat supplementation across turns. `maxRequests: 4` caps model turns, not total tools or evidence. This violates the planned one supplemental batch and total evidence ceiling and can grow the accumulated model context past its advertised budget.

Fix: share a task budget object across initial evidence and all tools; reserve and charge actual returned content, cap supplement rounds/tool batches, and return an explicit budget-exhausted result. Keep diagnostics/search bounded as well. Include a test with multiple tool calls in one turn and another supplementation turn.

### 2. Chunk outputs are appended without reconciling duplicate concepts/updates

Locations: `src/pi.js:146`, `src/pi.js:154`, `src/knowledge.js:43`.

Each chunk sees the same preexisting context and does not see earlier chunk drafts. Outputs are appended. If the same concept occurs in two chunks, both naturally propose the same title/target; `createProposal` then rejects the whole extraction after all paid calls. More seriously, a later correction under a different title is not reconciled with the earlier claim even though `sourceCoverage.complete` is true.

Fix: add a bounded reconciliation step that sees all chunk drafts and their source locations, groups identical targets, preserves contradictions/qualifiers, and produces one full update per page. Alternatively, explicitly return an incomplete reviewable result with unresolved duplicate drafts and do not report completion. Test a definition in the first chunk with a correction in the last chunk, plus two chunks updating the same existing target.

### 3. Requested project is only a prompt preference for model output

Location: `src/pi.js:160`.

Retrieval candidates respect `project`, but proposal creation accepts the model's `raw.project` unchanged. A request made with `--project Alpha` can therefore create a proposal in Beta and subsequently commit it there. The model is explicitly given every project and merely `preferredProject`, so this is not an unreachable input.

Fix: when the caller selects a project, require every returned item to use that project (or assign it deterministically for create actions); reject a mismatched update. Add a provider-fixture case returning a different project and verify no proposal is created.

### 4. Merge leaves path references to discarded items unresolved

Locations: `src/knowledge.js:81`, `src/knowledge.js:86`.

The implementation removes a few exact self-link spellings and redirects only `item:N` links. Valid exact paths ending in `.md`, aliased wiki links, and path links from other active items remain pointed at the discarded target. This breaks the documented relation union and commit flow.

Reproduced in a temporary vault: create `[1] one`, `[2] two`, `[3] three` with `[3].related = ['projects/Alpha/two.md']`; merge `[2]` into `[1]`; `[3]` still has a missing relation and commit `[1,3]` throws `UNRESOLVED_LINK`.

Fix: canonicalize every relation against existing and proposed targets, remove all merged self-relations, and redirect references from surviving items to the survivor using the same canonical form. Cover path, `.md`, wiki alias, and `item:N` forms.

### 5. Normal CLI tasks discard the new telemetry

Locations: `bin/akm.js:75`, `bin/akm.js:83`, `bin/akm.js:84`, `src/pi.js:69`.

`runPi` reports statistics only through an optional `onResult`; normal CLI answer and extraction calls supply none. No task ledger is saved or returned. A chunked extraction or query expansion also emits separate per-session callbacks rather than a task aggregate. Consequently the primary external-agent workflow cannot reproduce total request/usage/timing costs, despite measurement being stage 1 of the design.

Fix: allocate a task id in the workflow, aggregate all sessions and deterministic phases into one ledger, and persist success/failure records from the CLI. Store missing usage as unavailable and keep token subtotals separate. Test one expansion plus answer and one multi-chunk extraction via CLI, inspecting their saved cumulative records.

### 6. Conversation and complete prompt size have no task-budget preflight

Locations: `src/pi.js:117`, `src/pi.js:121`, `src/pi.js:142`, `src/pi.js:147`.

Conversations up to 2 MiB are sent as one request, unlike documents. Even for documents, the 48,000-character candidate check excludes the source chunk, full source notice paragraphs, JSON overhead, and system instructions. A large selected conversation or a long critical-notice paragraph can exceed the configured 64k context after a model request begins. This misses the approved requirement to reject/split oversized tasks before calling the model.

Fix: preflight the assembled prompt with an explicitly labeled token estimate (or tokenizer), chunk selected conversations on stable message boundaries where safe, and reject an oversized task before any request. Bound notices without silently losing their source location, and account for source plus candidate context together.

## Additional contract gaps

### 7. Reported evidence budget does not represent the serialized evidence sent to the model

Location: `src/evidence.js:59`.

The same text is serialized in both `content` and `passages[].text`, plus an uncharged snippet. A `budget.used` of 24,000 characters can therefore place over 48,000 evidence text characters in the next prompt, excluding metadata. Pages appended after the budget reaches zero can still contribute uncharged snippets. This amplifies finding 1.

Fix: choose one text representation for model-facing evidence or charge its actual serialization; omit snippets from the model representation if passages already carry the content. Keep a separate display representation if needed.

### 8. Chunk processing lacks stable paragraph locations and claim support

Locations: `src/source.js:3`, `src/pi.js:167`, `src/pi.js:173`.

Chunks are strings without original offsets/paragraph ids; every document item stores the whole document as its source. There is no draft-claim-to-paragraph support relation. Sending every chunk establishes input processing coverage, but cannot establish claim coverage or locate which chunk supports a condition. The approved design specifically requires this internal support mapping.

Fix: represent chunks with stable source id, paragraph ids and original offsets, require item support ids in model output, validate those ids, and carry them through deterministic merges. Describe `complete` as processing coverage unless content coverage is independently checked.

## Assessment

Ready to finalize: with fixes to the important findings. This review does not establish real-model quality or the performance targets; those require the frozen-corpus and complete-workflow experiments specified in the approved design. Full tests and final line references belong to the parent after implementation settles.
