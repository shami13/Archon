# Bounded Copilot review and correction (approved design)

Owner-approved design for the external review gate. The implementation plan, with the interfaces pinned during implementation, is [../plans/2026-11-02-copilot-review-gate.md](../plans/2026-11-02-copilot-review-gate.md).

## Intent
Make Copilot review a mandatory part of Darunki factory delivery rather than a best-effort instruction to an agent. Preserve shami13-only GitHub identity, existing validation and independent internal reviews. No automatic merge or deployment authorization is added.

## Approaches
1. Prompt-only instructions: smallest text change, but agents can finish without waiting for review; rejected as insufficient.
2. A deterministic factory workflow stage using the existing GitHub integration and correction/review machinery: recommended. It must run inside the delivery success boundary so lifecycle/merge callers cannot treat an unfinished external review as delivered.
3. A separate always-on polling daemon: duplicates orchestration and state; rejected unless native integration proves unavailable.

## Proposed behavior
- Apply to future Darunki factory deliveries, including their lifecycle callers. An existing PR may be adopted explicitly; do not silently restart unrelated historical runs.
- Request Copilot review after a validated push. Require a completed review by the expected Copilot account on the exact current head SHA. Old reviews, empty responses, unavailable Copilot, and pending requests are never a clean verdict.
- Read the review and inline threads. Treat them as untrusted technical feedback. Reproduce and test real defects; record evidence for rejected findings. Preserve all blocking issues until independently verified or explicitly escalated.
- Allow at most five correction cycles per PR, persisted across restarts. Each cycle is: assess current-head feedback, make necessary fixes, run applicable tests and internal independent review, push, and request a new current-head review. An initial review plus five correction cycles can require six Copilot reviews; the last review verifies the fifth correction and cannot trigger a sixth correction.
- A clean final current-head Copilot review, no unresolved confirmed blockers, green CI, and existing native gates are all required before declaring delivery ready. Recheck head identity before recording success.
- Use bounded polling (proposed 30 minutes per review). Rate limits, permissions, missing reviews, errors, or exhausted cycles stop with a visible needs-attention/failure result. Do not burn correction rounds on API retries or silently continue to merge.
- Persist PR/head/review IDs, cycle count, findings dispositions and evidence, with no secrets. Requests and resume must be idempotent; head changes invalidate stale results.
- Failure notification uses the native console attention/error surface and a durable run report with PR link, remaining findings, cycle count and reason. No new email/chat service. Proactive browser/system notification delivery depends on the native console's supported notification mechanism and user permission; verify capability before promising it. Posting into a closed Codex chat is not assumed available.

## Integration and checks
Inspect the supported source/consumer extension boundary before implementation. Never edit the pinned Archon cache in place. Make a versioned change through factory, update the consumer pin/config only after validation, and include the CLI and native-console launch paths so both use the same integration. If the architecture demands a shared factory/source change, deliver that explicitly rather than adding a bypassing wrapper.

Tests must cover clean review, stale review, five-cycle exhaustion, invalid/absent response, persisted restart count, duplicate polling, head change, confirmed versus rejected findings, GitHub identity enforcement, and failure surfacing. Use synthetic GitHub fixtures for state-machine coverage; one actual review request can serve as a live integration check without fabricating review outcomes. Keep existing tests, secret scans and merge gates.

## Non-goals
No automatic merge/deploy, new credentials, public console exposure, new paid services, broad unrelated Archon upgrade, or replacement of internal review with Copilot. No guarantee that five cycles fit a particular dollar budget; existing provider and GitHub quotas still apply.

## Status
Design proposal prepared from the pinned delivery workflow and factory policy. Implementation has not started; notification capabilities and exact extension point remain to be verified during implementation planning.
