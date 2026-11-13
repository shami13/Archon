/**
 * The external review on the loop's own routes (`simple` and `continue`), where no
 * delivery pipeline runs its gate.
 *
 * Only the Codex policy reviews here: it needs nothing but this host. Copilot is
 * requested, waited for and corrected inside archon-deliver's gate, and the merge
 * gate already holds a loop-built pull request no Copilot review passed.
 *
 * Codex reviews the pull request head in a temporary worktree, so the run's own
 * checkout (which the app check merges with the default branch) is never moved. The
 * loop has no correction cycle: blocking findings go to the loop reviewer, who gives
 * each one a disposition, as it does for the app check's lines, and sends the change
 * back when one is this change's to fix. A review with no blocking findings is
 * recorded `clean` in the pull request's ledger, which is what lets the merge gate
 * land the head; findings the reviewer declines leave the head held for the owner.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: the pull request URL (`$subject.output.pr`); empty when nothing was delivered.
 * - INPUTS_HEAD: the head the app check tests (`$subject.output.head`).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexCli, fetchBase, observeCodexReview } from '../../.shared/codex-review.ts';
import {
  Ledger,
  externalReviewDir,
  externalReviewPolicy,
  findingsOf,
  ghApi,
  pullRefOf,
  pullUrl,
  readPull,
  reportStop,
  writeFindings,
  writeObservation,
  writeReport,
  type Observation,
} from '../../.shared/external-review.ts';
import { artifactsDir, emit, refuse, runId, stateDir, trimmed } from '../../.shared/io.ts';

const pr = trimmed(process.env.INPUTS_PR);
const head = trimmed(process.env.INPUTS_HEAD);

function git(args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'ignore', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
}

/**
 * The pull request's head as git sees it; the REST API can lag a push made moments ago, as `subject` notes.
 * It lands in a ref of its own: check-app fetches in the same checkout at the same time and rewrites FETCH_HEAD.
 */
function gitPullHead(number: number): string {
  const ref = `refs/remotes/origin/loop-external-review-${String(number)}`;
  git(['fetch', '--quiet', 'origin', `+refs/pull/${String(number)}/head:${ref}`]);
  const result = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', ref], { stdout: 'pipe', stderr: 'ignore' });
  return result.stdout.toString().trim();
}

function skip(reason: string): void {
  emit({ ran: 'false', reason, review: '', head, blocking: 0, findings: '' });
}

/** Codex's review of `head` in a worktree of its own, removed afterwards whatever happens. */
function observe(ledger: Ledger, url: string, base: string): Observation {
  git(['fetch', '--quiet', 'origin', head]);
  const checkout = mkdtempSync(join(tmpdir(), 'archon-codex-review-'));
  try {
    git(['worktree', 'add', '--quiet', '--detach', checkout, head]);
    return observeCodexReview(head, { ledger, cwd: checkout, url, base, runner: codexCli, fetchBase, now: Date.now });
  } finally {
    Bun.spawnSync(['git', 'worktree', 'remove', '--force', checkout], { stdout: 'ignore', stderr: 'ignore' });
    rmSync(checkout, { recursive: true, force: true });
  }
}

function review(): void {
  const ref = pullRefOf(pr);
  const ledger = Ledger.forPull(stateDir(), ref, runId());
  try {
    const pull = readPull(ghApi, ref);
    if (pull.state !== 'open') throw new Error(`${pullUrl(ref)} is ${pull.state}, not open`);
    const current = pull.head === head ? head : gitPullHead(ref.number);
    if (current !== head) {
      throw new Error(`the pull request head is ${current}, not ${head}, the head this lap checks`);
    }
    // A delivery gate that already settled this head (clean or adjudicated) is what the merge gate reads.
    if (ledger.ready(head)) {
      skip(`the external review gate already passed ${head}, so its findings do not block it again`);
      return;
    }
    const observed = observe(ledger, pullUrl(ref), pull.base);
    writeObservation(artifactsDir(), ledger, ref, observed);
    const findings = findingsOf(observed.comments, [], 'codex');
    const { id, url, state, submittedAt, body } = observed.review;
    const feedback = { pr: ref, head, review: { id, url, state, submittedAt, body }, comments: observed.comments };
    writeFindings(artifactsDir(), feedback, findings, undefined);
    if (findings.length === 0) {
      ledger.recordVerdict({ review: observed.review.id, head, verdict: 'clean', findings: 0 });
    }
    writeReport(artifactsDir(), ledger, {
      ref,
      status: findings.length === 0 ? 'clean' : 'findings for the loop review',
      reason:
        findings.length === 0
          ? 'Codex found nothing that blocks this head'
          : 'the loop reviewer gives every finding a disposition and sends the change back for the ones this change must fix',
      head,
      reviewUrl: observed.review.url,
      findings,
    });
    emit({
      ran: 'true',
      reason: observed.review.body,
      review: observed.review.id,
      head,
      blocking: findings.length,
      findings: join(externalReviewDir(artifactsDir()), 'findings.json'),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reportStop(ledger, { ref, status: 'stopped while reviewing', reason, head }));
  }
}

try {
  const { mode } = externalReviewPolicy();
  if (mode !== 'codex') skip(`the external review policy is ${mode}; only Codex reviews on the loop's routes`);
  else if (pr === '') skip('nothing was delivered, so there is nothing to review');
  else review();
} catch (error) {
  refuse(`external-review: ${error instanceof Error ? error.message : String(error)}`);
}
