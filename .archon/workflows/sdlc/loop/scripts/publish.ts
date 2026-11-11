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
import { rawLine, reportLine, repoOfOrigin, withCodexReviewSection } from '../../.shared/builder-report.ts';
import { storeReview, type CodexReview } from '../../.shared/codex-review.ts';
import { Ledger, pullRefOf } from '../../.shared/external-review.ts';
import { forgeSource, type ForgeSource, type QualifiedPr } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, runId, stateDir, trimmed } from '../../.shared/io.ts';
import { createPr, editPrBody, findOpenPrByHead, markPrReady, upsertComment, viewPr } from '../../.shared/pr.ts';

const BLOCKING = ['P0', 'P1', 'P2'];

function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

function readIf(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** The builder's one comment for this run, written once however often this node is resumed. */
function leaveComment(ref: QualifiedPr, source: ForgeSource): void {
  const comment = readIf(join(artifactsDir(), 'pull-request', 'comment.md'));
  if (comment === undefined || comment.trim() === '') return;
  const marker = `<!-- archon-loop builder ${runId()} -->`;
  const path = join(artifactsDir(), 'pull-request-comment.md');
  writeFileSync(path, `${marker}\n${comment}`);
  upsertComment(ref, marker, path, source);
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
  const files = join(artifactsDir(), 'pull-request');
  const source = forgeSource();
  // This node runs whatever the gate did, so that a failed gate is a fact downstream reads
  // (`published: "false"`, no pull request this lap) rather than a hole in the graph. It pushes
  // only when the latest review is of HEAD and clean.
  if (review?.head === head && review.findings.some(finding => BLOCKING.includes(finding.priority))) {
    emit({ pr: '', head, published: 'false', reason: `the pre-push review of ${head.slice(0, 7)} still has blocking findings` });
    return;
  }
  if (review !== undefined && review.head !== head) {
    emit({ pr: '', head, published: 'false', reason: `HEAD is ${head.slice(0, 7)} but the last review read ${review.head.slice(0, 7)}` });
    return;
  }
  if (review === undefined && !/^none\b/i.test(rawLine(builder, 'COMMIT') ?? '')) {
    // Without an explicit `COMMIT: none` the gate did not finish: nothing is pushed, edited or marked ready.
    emit({ pr: '', head, published: 'false', reason: `the gate recorded no review of ${head.slice(0, 7)} and the builder did not report COMMIT: none` });
    return;
  }
  if (review === undefined) {
    // The gate reviewed nothing because the builder committed nothing. A move it gave up (PR: none) changes
    // nothing; a continued pull request that needed only its body, comment or ready state still gets those.
    const kept = reportLine(builder, 'PR');
    if (upstream === '' || kept === undefined) {
      // No commit and no retained pull request: the builder gave the move up, so this lap delivered nothing.
      emit({ pr: '', head, published: 'false', reason: 'the builder committed nothing and retained no pull request' });
      return;
    }
    // The writes go to the pull request this move continues, never to one the report happens to name.
    if (kept !== upstream) throw new Error(`the builder reports ${kept}, but this move continues ${upstream}; nothing is written`);
    const ref = pullRefOf(kept);
    const current = viewPr(ref, source);
    if (current.pr.state !== 'open') {
      emit({ pr: '', head, published: 'false', reason: `${kept} is ${current.pr.state}; nothing is written to it` });
      return;
    }
    const body = readIf(join(files, 'body.md'));
    if (body !== undefined && body !== current.body) {
      const bodyPath = join(artifactsDir(), 'pull-request-body.md');
      writeFileSync(bodyPath, body);
      editPrBody(ref, bodyPath, source);
    }
    leaveComment(ref, source);
    if (current.pr.is_draft) markPrReady(ref, source);
    emit({ pr: kept, head, published: 'true', reason: 'the builder committed nothing; the pull request was brought up to date' });
    return;
  }
  if (review.head !== head) {
    throw new Error(`HEAD is ${head.slice(0, 7)} but the clean review read ${review.head.slice(0, 7)}; nothing is pushed until it is reviewed again`);
  }

  const repo = repoOfOrigin(git(['remote', 'get-url', 'origin']));
  // origin may push somewhere else than it fetches from; every push destination must be this same repository.
  for (const pushUrl of git(['remote', 'get-url', '--push', '--all', 'origin']).split('\n')) {
    const destination = repoOfOrigin(pushUrl);
    if (destination.host !== repo.host || destination.path.toLowerCase() !== repo.path.toLowerCase()) {
      throw new Error(`origin pushes to ${destination.path}, not to ${repo.path}; nothing is pushed`);
    }
  }
  const section = reviewSection(review);
  const bodyPath = join(artifactsDir(), 'pull-request-body.md');

  // An earlier attempt of this node may have opened the pull request already; find it by its branch.
  const reported = reportLine(builder, 'PR');
  if (upstream !== '' && reported !== undefined && reported !== upstream) {
    throw new Error(`the builder reports ${reported}, but this move continues ${upstream}; nothing is pushed`);
  }
  let url = upstream || reported || findOpenPrByHead(repo, repo, branch, source)?.pr.url || '';
  if (url !== '') {
    const existing = viewPr(pullRefOf(url), source).pr;
    // A pull request merged or closed while Codex reviewed gets no push: its branch is history now.
    if (existing.state !== 'open') {
      emit({ pr: '', head, published: 'false', reason: `${url} is ${existing.state}; the reviewed commit was not pushed` });
      return;
    }
    if (existing.head_repo !== null && (existing.head_repo.host.toLowerCase() !== repo.host || existing.head_repo.path.toLowerCase() !== repo.path.toLowerCase())) {
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
  leaveComment(pullRefOf(url), source);
  storeReview(Ledger.forPull(stateDir(), pullRefOf(url), runId()), review);
  emit({ pr: url, head, published: 'true', reason: `pushed ${head.slice(0, 7)} after a clean review` });
}

if (import.meta.main) {
  try {
    publish();
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
}
