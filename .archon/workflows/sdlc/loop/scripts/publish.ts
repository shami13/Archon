/**
 * The push, after the review: the builder's branch goes to origin, the pull request is
 * opened or brought up to date with the review's summary in its body, and the review is
 * stored beside the pull request's ledger so the gate after the push reuses it.
 *
 * Only the commit the clean pre-push review read is pushed: a HEAD that differs from it is
 * refused, whatever moved it. A pull request opened by an earlier attempt of this node is
 * found again by its branch, so a resume reconciles it instead of opening a second one. A
 * continued pull request whose head lives in another repository is refused: this node
 * pushes to origin only.
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
import { artifactsDir, emit, refuse, runId, stateDir, trimmed } from '../../.shared/io.ts';
import { createPr, editPrBody, findOpenPrByHead, markPrReady, viewPr } from '../../.shared/pr.ts';

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

/** What the body says about the review: its summary line, plus any blocking finding it still names. */
export function reviewSection(review: CodexReview): string {
  const blocking = review.findings.filter(finding => BLOCKING.includes(finding.priority));
  const verdict = blocking.length === 0 ? 'approve' : `${String(blocking.length)} blocking finding(s)`;
  const lines = [
    `Codex pre-push review of ${review.head.slice(0, 7)}: ${verdict}, ${String(review.findings.length - blocking.length)} advisory note(s). ${review.assessment}`,
  ];
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
    // The gate reviewed nothing: the builder committed nothing, so there is nothing to push, open or mark ready.
    emit({ pr: upstream, head });
    return;
  }
  if (review.head !== head) {
    throw new Error(`HEAD is ${head.slice(0, 7)} but the clean review read ${review.head.slice(0, 7)}; nothing is pushed until it is reviewed again`);
  }

  const source = forgeSource();
  const repoView = JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])) as { nameWithOwner: string };
  const repo: QualifiedPr['repo'] = { host: 'github.com', path: repoView.nameWithOwner };
  const files = join(artifactsDir(), 'pull-request');
  const section = reviewSection(review);
  const bodyPath = join(artifactsDir(), 'pull-request-body.md');

  // An earlier attempt of this node may have opened the pull request already; find it by its branch.
  let url = upstream || reportLine(builder, 'PR') || findOpenPrByHead(repo, repo, branch, source)?.pr.url || '';
  if (url !== '') {
    const existing = viewPr(pullRefOf(url), source).pr;
    if (existing.head_repo !== null && existing.head_repo.path !== repo.path) {
      throw new Error(`${url} has its head in ${existing.head_repo.path}; this loop pushes to origin only`);
    }
    if (existing.head !== branch) throw new Error(`${url} has head ${existing.head}, not the builder's branch ${branch}`);
    // The review diffed against this base; a pull request into another branch is a different change.
    if (existing.base !== review.base) throw new Error(`${url} merges into ${existing.base}, but the review diffed against ${review.base}`);
  }
  // The reviewed commit by its SHA, so a branch that moved meanwhile cannot slip in.
  git(['push', '--set-upstream', 'origin', `${head}:refs/heads/${branch}`]);

  if (url === '') {
    const issue = /\/issues\/(\d+)\/?$/.exec(target)?.[1];
    const body = readIf(join(files, 'body.md')) ?? (issue === undefined ? '' : `Closes #${issue}\n`);
    writeFileSync(bodyPath, withCodexReviewSection(body, section));
    const title = (readIf(join(files, 'title.txt')) ?? git(['log', '-1', '--format=%s'])).trim();
    const created = createPr(
      { repo, headRepo: repo, head: branch, headRevision: head, base: review.base, title, bodyPath, draft: false },
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
  storeReview(Ledger.forPull(stateDir(), pullRefOf(url), runId()), review);
  emit({ pr: url, head });
}

if (import.meta.main) {
  try {
    publish();
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
}
