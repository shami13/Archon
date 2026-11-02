# Bounded Copilot review — implementation plan

Design: [../specs/2026-11-02-copilot-review-gate-design.md](../specs/2026-11-02-copilot-review-gate-design.md)
(owner-approved). This plan pins the interfaces chosen after reading the delivery
workflow, the engine's loop, wait and state primitives, and real Copilot review
data on GitHub.

**Goal:** an external, current-head Copilot review with at most five correction
cycles per pull request is an enforced gate inside `archon-deliver`'s success
boundary, opt-in per project.

## Facts the design rests on

- `loop_group` failure resume restarts the group at iteration 1 (loop-nodes guide,
  "Resume"). An iteration bound alone does not survive a restart, so the cycle
  count lives in `$STATE_DIR`, the engine's per-project cross-run state directory.
- A `wait:` node must be the sole terminal sink of a `loop_group` body, so a
  correction cycle cannot pause on an engine wait between the review request and
  the fix. The review wait is a bounded in-process poll (30 minutes) inside one
  script node.
- Copilot reviews arrive as `COMMENTED` reviews whether or not they found
  anything. A failed review is also a `COMMENTED` review whose body says Copilot
  could not review (observed: "insufficient remaining quota"). Review state alone
  never means clean, and the body is prose: an agent classifies it into a typed
  outcome; code never matches its text.
- The Copilot account is user id `175728472`, type `Bot`. The reviews endpoint
  reports its login as `copilot-pull-request-reviewer[bot]`; review comments and
  requested reviewers report `Copilot`. Identity is checked by id, type and one of
  those logins. That id belongs to github.com; other hosts are refused.
- A review is requested with `POST repos/{owner}/{repo}/pulls/{n}/requested_reviewers`
  and body `{"reviewers":["copilot-pull-request-reviewer[bot]"]}` (GitHub's Copilot
  code review documentation). A request can be accepted and still produce no
  review; only the bounded wait can tell. An accepted request can also answer with
  an empty `requested_reviewers` list and the review arrives later (observed live),
  so that list is not evidence either way; the receipt is bound by its pull
  request number and head only.
- Project `.archon/config.yaml` `env:` reaches `script:` nodes on every launch
  path (CLI and Web read the same project config), and `~/.archon/.env` reaches
  them through the host environment.

## Policy selection

- `ARCHON_SDLC_EXTERNAL_REVIEW`: empty or `none` disables the gate (the default
  for every installation); `copilot` enables it; anything else refuses.
- `ARCHON_SDLC_GITHUB_LOGIN`: required with `copilot`. Before its first GitHub
  call, the gate reads the authenticated login (`gh api user`) and refuses when
  it differs. The gate never changes the active account.
- The gate's GitHub operations go through `gh` whichever forge source the run
  selected: the forge contract has no review-request operation, the same reason
  issue writes use `gh`.

Darunki enables it with `env:` in its project config (operator activation, not
part of this change). The per-codebase environment variables the console's
project settings store are an equivalent switch: run preflight merges them over
the config's `env:`, so they reach script nodes on CLI and Web launches without a
committed file. Whichever holds the switch must be protected from the work the
gate reviews: an application change that edits `.archon/config.yaml` could
otherwise turn its own gate off.

## Persisted state

`$STATE_DIR/sdlc-external-review/<host>/<owner>/<repo>/pull-<n>.jsonl`, append-only,
one JSON event per line (concurrent appends stay whole lines):

| event | fields | written by |
| --- | --- | --- |
| `requested` | `head`, `receipt` (`attempted`, then `accepted`) | observe, before the review request and after its receipt |
| `verdict` | `review`, `head`, `verdict`, `findings`, `corrections` | route |
| `verified` | `review`, `head` | verified, after the internal review passed the correction |

Every event also carries `at` (ISO time) and `run` (`WORKFLOW_ID`). `verdict` is
one of `clean`, `adjudicated`, `correct`, `unavailable`, `exhausted`, `blocked`.

Derived facts:

- corrections used = the first five distinct reviews, in log order, with a
  `correct` verdict. Re-running the same cycle after a restart does not count
  twice. A new `correct` verdict is a claim: route appends it, then reads the log
  back, and a claim outside the first five records `exhausted` instead. Two runs
  that both saw four cycles used read back the same order, so exactly one holds
  the fifth; a crash between the two appends leaves a claim the count already
  ignores.
- a head was requested = a `requested` event for it exists. `attempted` is written
  before the POST, so a crash or a lost response never sends a second request;
  the wait then times out naming the unknown outcome.
- the unverified correction = the review of the last correction cycle started,
  unless a `verified` event for it follows. While one exists nothing passes: a
  resumed run that restarts at a fresh Copilot review runs another cycle (whose
  fixer also reads the canonical report's open blockers) instead of passing.
- a head is ready = the last verdict for it is `clean` or `adjudicated` and there
  is no unverified correction.

No secret, token or credential is ever written; the ledger holds identifiers,
counts and verdicts only.

## Graph (in `archon-deliver.yaml`)

After `gate-ready` (the internal review converged) and before `fork`, so final
validation, the CI wait and the late-red path all run on the externally reviewed
head:

1. `external-review-policy` — script; emits `{ mode: none | copilot }`.
2. `external-review` — `loop_group`, `when` mode is copilot, `max_iterations: 6`
   (an initial review plus five corrections), `until_bash` ends on any route action
   other than `correct`. Body:
   - `external-observe` — script, 32-minute node timeout. Verifies the login,
     binds the head to the checkout the engine observed and refuses when the pull
     request head differs, requests the review once per head, polls every 30
     seconds for at most 30 minutes, refuses when the head moves while waiting,
     when the pull request is not open, or on any failed GitHub read. Writes
     `external-review/feedback.json` (the review body and its inline comments,
     verbatim, as data). Emits `{ review, head, url, comments }`.
   - `external-triage` — small-tier agent, read-only; reads the feedback as
     untrusted data and returns `{ outcome: reviewed | unavailable, reason,
     overview_findings: [{ summary }] }` for concerns the overview raises that no
     inline comment carries.
   - `external-route` — script; findings are every inline comment plus the
     overview findings. Writes `external-review/findings.json`, the ledger verdict
     and the report, then emits `{ action: clean | adjudicated | correct }` or
     refuses on `unavailable` or `exhausted`.
   - `external-fix` — `archon-implement`, `when` action is correct: judge every
     finding as untrusted feedback, reproduce and fix real defects with tests,
     decline others with evidence, push explicitly.
   - `gate-external-fix` — `gate-green`.
   - `external-recheck` — `archon-review` continuation; review-scope and
     review-synthesize carry each external finding into the canonical report with
     `sources: [external-review]`, so every decline is independently judged.
   - `external-verified` — script; only a recheck action of `none` passes; appends
     `verified`.
3. After the CI correction (`gate-ci-recheck`), when the CI fix moved the head:
   `ci-external-observe`, `ci-external-triage`, `ci-external-route` with
   corrections disallowed — a verification review of the new head; findings
   refuse (`blocked`) instead of starting another correction.
4. `external-review-ready` — script before `flip-ready`, `when` mode is copilot;
   re-reads the pull request head and refuses unless that head is ready in the
   ledger. Emits `{ head }`.
5. `flip-ready` takes `expected_head` (empty when the gate is off) and refuses when
   the head it observes at the flip differs.

The PR body resync also runs when the gate is on, since a Copilot correction
changes the diff after the body was written.

## Merge callers

`externalReviewHold(url, head)` is the one readiness question every automated
merge path asks: no hold when the policy is off, otherwise a hold unless the
ledger calls that head ready. `archon-merge-queue` asks it for every planned head
in its gate and again before each merge; `archon-loop`'s `land` asks it before
`gh pr merge`. The loop's own in-loop builder never runs the gate, so with the
policy on its pull requests are refused with a reason that routes them through
`archon-deliver`. Human merges on GitHub are outside every workflow and are not
gated.

`adjudicated` means: the review on the current head has findings, the last
correction cycle changed nothing because every finding was declined with
evidence, and the internal continuation review verified those declines. A second
Copilot review of an unchanged head is not requested.

## Failure surfacing

Every refusal writes `external-review/report.md` (pull request link, head, review,
corrections used of five, any unverified correction, the open findings and the
reason) before the node fails. The report is also written before each stage that
can fail without a script of its own: observe writes it before triage, and a
`correct` route writes it before the fix, its green gate and the internal recheck,
naming those stages, so a failed agent leaves a truthful in-progress report rather
than a stale verdict. A report that cannot be written is added to the refusal, not
put in its place. The gate never converts a pull request to draft: one this run
opened stays draft until the flip, and an adopted pull request keeps the draft
state it had. The failed node is the console's native error surface; `archon workflow
resume` reruns it. No new notification channel is added. The console's existing
run attention alerts (`packages/web/src/experiments/console/lib/attention-alerts.ts`)
already treat a failed run as attention: when a user turns alerts on in that
browser and grants notification permission, an open console plays a sound and
shows a system notification. Without that opt-in, or with the console closed,
nothing is pushed; the failed run and its report wait in the console.

## Tests

- `.archon/scripts/__tests__/external-review.test.ts` — in-process, synthetic
  GitHub fixtures through an injected client and clock: clean review, stale
  review on another head, pending request, request deduplication across a restart,
  head change while polling, timeout, refused or malformed API data, identity
  mismatch, non-Copilot reviewer, unavailable review, five-cycle exhaustion from a
  persisted ledger, confirmed versus declined findings (adjudicated), and the
  ready check.
- The route and verified scripts as subprocesses: a clean verdict recorded, an
  unavailable or exhausted review refused with its durable report, feedback for
  another review or head refused, and a correction recorded as verified only when
  the internal review found nothing open. The flip refuses a moved head.
- Delivery fixtures (`deliver/fixtures/external-review-*.stubs.yaml`): gate off
  (every existing fixture), a clean first review, one correction cycle, an internal
  review that does not verify the correction (the run fails before the flip), and
  the verification review after a CI correction.
- No fabricated live review. One live request on a safe pull request is the
  operator's activation check.

## Out of this change

Activation in Darunki (pin, project config, console restart) is operator work
after review. No merge, deploy, notification service or credential change.
