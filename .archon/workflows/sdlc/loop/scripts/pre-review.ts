/**
 * Codex reads the builder's commit before it leaves the checkout.
 *
 * The loop pushes nothing until this review has no blocking finding (or the correction
 * rounds are spent, in which case publish carries the findings into the pull request).
 * The review is of the commits the branch adds on top of the default branch, in the run's
 * own checkout, and is kept in this run's artifacts; publish stores it beside the pull
 * request's ledger once the pull request exists, so the gate after the push reuses it
 * instead of reviewing the same head again.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_BUILDER: the builder's report; its `BRANCH:` line names the branch to review.
 * - INPUTS_PR: the pull request URL when the move continues one; empty for a new issue.
 */
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rawLine, reportLine } from '../../.shared/builder-report.ts';
import { codexCli, fetchBase, runCodexReview, type CodexFinding } from '../../.shared/codex-review.ts';
import { pullRefOf } from '../../.shared/external-review.ts';
import { forgeSource } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, trimmed } from '../../.shared/io.ts';
import { viewPr } from '../../.shared/pr.ts';

const BLOCKING = ['P0', 'P1', 'P2'];

function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

/** The branch the repository merges into, as origin advertises it now; a cached origin/HEAD can be stale or absent. */
function defaultBranch(): string {
  const advertised = git(['ls-remote', '--symref', 'origin', 'HEAD']);
  const name = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(advertised)?.[1];
  if (name === undefined) throw new Error('origin advertises no default branch; cannot tell what the change merges into');
  return name;
}

/** The one line a pull request body carries as the review's evidence. */
export function summaryLine(head: string, findings: readonly CodexFinding[], assessment: string): string {
  const blocking = findings.filter(finding => BLOCKING.includes(finding.priority)).length;
  const verdict = blocking === 0 ? 'approve' : `${String(blocking)} blocking finding(s)`;
  return `Codex pre-push review of ${head.slice(0, 7)}: ${verdict}, ${String(findings.length - blocking)} advisory note(s). ${assessment}`;
}

function review(): void {
  const builder = trimmed(process.env.INPUTS_BUILDER);
  const pr = trimmed(process.env.INPUTS_PR);
  const branch = reportLine(builder, 'BRANCH') ?? git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== branch) throw new Error(`the checkout is on ${current}, not on the builder's branch ${branch}`);
  const dir = join(artifactsDir(), 'pre-review');
  mkdirSync(dir, { recursive: true });
  // Which review this is in this run: one file per reviewed head is already there for each earlier round.
  const round = String(readdirSync(dir).filter(name => name.endsWith('.json') && name !== 'latest.json').length + 1);
  const head = git(['rev-parse', 'HEAD']);
  // Codex reads the working tree; it must be the commit that gets pushed, nothing more and nothing less.
  if (git(['status', '--porcelain']) !== '') throw new Error('the checkout has uncommitted or untracked changes; commit or remove them before the review');
  // The builder's report says what it committed, or `COMMIT: none` when the move was wrong or a decision is the
  // owner's; a report without a readable COMMIT line is a report this gate cannot act on.
  const written = rawLine(builder, 'COMMIT');
  if (written === undefined) throw new Error("the builder's report has no COMMIT line; nothing is reviewed or pushed");
  const committed = reportLine(builder, 'COMMIT');
  if (committed !== undefined && !/^[0-9a-f]{7,40}$/i.test(committed)) throw new Error(`the builder's COMMIT line (${committed}) is not a commit SHA`);
  if (committed === undefined) {
    emit({ head, clean: 'true', blocking: 0, review: '', summary: 'the builder committed nothing; nothing to review or push', round });
    return;
  }
  // A correction round commits on top of the builder's commit, so HEAD is that commit or a descendant of it.
  const descends = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', committed, 'HEAD'], { stdout: 'ignore', stderr: 'ignore' });
  if (descends.exitCode !== 0) throw new Error(`HEAD ${head.slice(0, 7)} does not contain the builder's COMMIT ${committed.slice(0, 7)}`);
  // A continued pull request may merge into a branch other than the default one; review against that.
  const base = pr === '' ? defaultBranch() : viewPr(pullRefOf(pr), forgeSource()).pr.base;
  fetchBase(process.cwd(), base);
  if (git(['rev-list', '--count', `origin/${base}..HEAD`]) === '0') {
    emit({ head, clean: 'true', blocking: 0, review: '', summary: `no commits beyond origin/${base}; nothing to review`, round });
    return;
  }
  const result = runCodexReview(head, {
    cwd: process.cwd(),
    url: pr === '' ? `branch ${branch} (no pull request yet)` : pr,
    base,
    history: [],
    runner: codexCli,
    fetchBase: () => undefined,
    now: Date.now,
  });
  const path = join(dir, `${head}.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  // publish reads the latest review whatever head it was of, and says so when the head moved on.
  copyFileSync(path, join(dir, 'latest.json'));
  const blocking = result.findings.filter(finding => BLOCKING.includes(finding.priority)).length;
  emit({
    head,
    clean: blocking === 0 ? 'true' : 'false',
    blocking,
    review: path,
    summary: summaryLine(head, result.findings, result.assessment),
    round,
  });
}

if (import.meta.main) {
  try {
    review();
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
}
