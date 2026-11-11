/**
 * The push, after the review: the builder's branch goes to origin, the pull request is
 * opened or brought up to date with the review's summary in its body, and the review is
 * stored beside the pull request's ledger so the gate after the push reuses it.
 *
 * Only the commit the pre-push review read is pushed: a HEAD that moved since is refused,
 * and a review of an older head (the correction rounds ran out) is named as such in the
 * body, so the reviewers see what Codex still held against it.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_BUILDER: the builder's report (`BRANCH:` and, for a continued move, `PR:` lines).
 * - INPUTS_PR: the pull request URL the move continues; empty for a new issue.
 * - INPUTS_TARGET: the work item URL; a new pull request body closes it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportLine, withCodexReviewSection } from '../../.shared/builder-report.ts';
import { storeReview, type CodexReview } from '../../.shared/codex-review.ts';
import { Ledger, pullRefOf } from '../../.shared/external-review.ts';
import { forgeSource, type QualifiedPr } from '../../.shared/forge.ts';
import { artifactsDir, emit, note, refuse, runId, stateDir, trimmed } from '../../.shared/io.ts';
import { createPr, editPrBody, markPrReady, viewPr } from '../../.shared/pr.ts';

const BLOCKING = ['P0', 'P1', 'P2'];

function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

function gh(args: string[]): string {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

function readIf(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function defaultBranch(): string {
  const result = Bun.spawnSync(['git', 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { stdout: 'pipe', stderr: 'ignore' });
  const ref = result.stdout.toString().trim();
  return ref.startsWith('refs/remotes/origin/') ? ref.slice('refs/remotes/origin/'.length) : 'main';
}

/** What the body says about the review: the summary, the blocking findings, or that the pushed head has none. */
export function reviewSection(head: string, review: CodexReview | undefined): string {
  if (review === undefined) return `No Codex pre-push review of ${head.slice(0, 7)} was recorded.`;
  const blocking = review.findings.filter(finding => BLOCKING.includes(finding.priority));
  const verdict = blocking.length === 0 ? 'approve' : `${String(blocking.length)} blocking finding(s)`;
  const lines = [
    `Codex pre-push review of ${review.head.slice(0, 7)}: ${verdict}, ${String(review.findings.length - blocking.length)} advisory note(s). ${review.assessment}`,
  ];
  if (review.head !== head) {
    lines.push('', `The pushed commit ${head.slice(0, 7)} came after that review; its correction rounds were spent, so Codex has not read it.`);
  }
  for (const finding of blocking) {
    lines.push('', `- [${finding.priority}] ${finding.title} (${finding.path}${finding.line === null ? '' : `:${String(finding.line)}`}): ${finding.problem} Fix: ${finding.fix}`);
  }
  return lines.join('\n');
}

function publish(): void {
  const builder = trimmed(process.env.INPUTS_BUILDER);
  const target = trimmed(process.env.INPUTS_TARGET);
  const branch = reportLine(builder, 'BRANCH') ?? git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== branch) throw new Error(`the checkout is not on ${branch}`);
  const head = git(['rev-parse', 'HEAD']);
  const reviewPath = join(artifactsDir(), 'pre-review', 'latest.json');
  const review = existsSync(reviewPath) ? (JSON.parse(readFileSync(reviewPath, 'utf8')) as CodexReview) : undefined;
  const upstream = trimmed(process.env.INPUTS_PR);
  if (review === undefined) {
    // The gate reviews nothing when the branch adds no commit; then there is nothing to push either.
    const base = upstream === '' ? defaultBranch() : viewPr(pullRefOf(upstream), forgeSource()).pr.base;
    if (git(['rev-list', '--count', `origin/${base}..HEAD`]) !== '0') throw new Error(`no pre-push review of ${head.slice(0, 7)} was recorded; nothing is pushed`);
    emit({ pr: upstream, head });
    return;
  }
  if (review.head !== head) note(`publishing ${head.slice(0, 7)}, which the last pre-push review (${review.head.slice(0, 7)}) did not read`);

  git(['push', '--set-upstream', 'origin', `${branch}:${branch}`]);

  const source = forgeSource();
  const repoView = JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'])) as {
    nameWithOwner: string;
    defaultBranchRef: { name: string };
  };
  const repo: QualifiedPr['repo'] = { host: 'github.com', path: repoView.nameWithOwner };
  const files = join(artifactsDir(), 'pull-request');
  const section = reviewSection(head, review);
  const bodyPath = join(artifactsDir(), 'pull-request-body.md');

  let url = trimmed(process.env.INPUTS_PR) || reportLine(builder, 'PR') || '';
  if (url === '') {
    const issue = /\/issues\/(\d+)\/?$/.exec(target)?.[1];
    const body = readIf(join(files, 'body.md')) ?? (issue === undefined ? '' : `Closes #${issue}\n`);
    writeFileSync(bodyPath, withCodexReviewSection(body, section));
    const title = (readIf(join(files, 'title.txt')) ?? git(['log', '-1', '--format=%s'])).trim();
    const created = createPr(
      { repo, headRepo: repo, head: branch, headRevision: head, base: repoView.defaultBranchRef.name, title, bodyPath, draft: false },
      source
    );
    url = created.url;
  } else {
    const ref = pullRefOf(url);
    const current = viewPr(ref, source);
    // The builder writes the whole new body; the current one stands when it wrote none.
    writeFileSync(bodyPath, withCodexReviewSection(readIf(join(files, 'body.md')) ?? current.body, section));
    editPrBody(ref, bodyPath, source);
    if (current.pr.is_draft) markPrReady(ref, source);
  }
  const comment = readIf(join(files, 'comment.md'));
  if (comment !== undefined && comment.trim() !== '') gh(['pr', 'comment', url, '--body-file', join(files, 'comment.md')]);
  if (review?.head === head) storeReview(Ledger.forPull(stateDir(), pullRefOf(url), runId()), review);
  emit({ pr: url, head });
}

if (import.meta.main) {
  try {
    publish();
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
}
