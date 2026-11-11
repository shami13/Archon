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
import { canonicalRepoOfOrigin, publicationDeclined, rawLine, reportLine, withCodexReviewSection } from '../../.shared/builder-report.ts';
import { storeReview, type CodexReview } from '../../.shared/codex-review.ts';
import { Ledger, pullRefOf } from '../../.shared/external-review.ts';
import { forgeSource, sameRepo, type ForgeSource, type QualifiedPr } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, runId, stateDir, trimmed } from '../../.shared/io.ts';
import { createPr, editPrBody, findPrByHead, markPrReady, upsertComment, viewPr } from '../../.shared/pr.ts';

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

/**
 * The pull request's head must live in origin, where this loop pushes. A head repository the forge
 * did not name is refused too: a push to origin would then update a branch the pull request may not read.
 */
export function assertHeadInOrigin(url: string, headRepo: QualifiedPr['repo'] | null, origin: QualifiedPr['repo']): void {
  if (headRepo === null) throw new Error(`${url} names no head repository; this loop pushes to origin only and cannot tell that origin holds its head`);
  if (!sameRepo(headRepo, origin)) throw new Error(`${url} has its head in ${headRepo.path}; this loop pushes to origin only`);
}

/** Whether two pull request URLs name the same pull request, whatever their spelling (a trailing slash, letter case). */
export function samePullRequest(left: string, right: string): boolean {
  const a = pullRefOf(left);
  const b = pullRefOf(right);
  return sameRepo(a.repo, b.repo) && a.number === b.number;
}

/**
 * A continuation the builder gave up: its report says `PR: none` although the move continues a pull
 * request. For a new issue `PR: none` is the normal state before the pull request exists.
 */
export function abandonedContinuation(report: string, upstream: string): boolean {
  return upstream !== '' && /^none\b/i.test(rawLine(report, 'PR') ?? '');
}

/** A builder that committed on the base itself has no branch to open a pull request from; a push would advance the base. */
export function refuseBaseBranch(branch: string, base: string): void {
  if (branch === base) throw new Error(`the builder's branch is ${branch}, the base itself; nothing is pushed`);
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
  // The builder's decision comes first, on both routes: a clean review of a commit it made before giving the move up
  // (an owner's decision needed, a wrong pick) does not push it or touch a pull request.
  if (publicationDeclined(builder)) {
    emit({ pr: '', head, published: 'false', reason: 'the builder reports PUBLISH: no; nothing is pushed or written' });
    return;
  }
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
  if (review === undefined) {
    // The gate records the no-commit path it completed, for the HEAD it saw; anything else is a gate that did not finish.
    const none = readIf(join(artifactsDir(), 'pre-review', 'none.json'));
    const completedFor = none === undefined ? undefined : (JSON.parse(none) as { head?: unknown }).head;
    if (completedFor !== head) {
      emit({ pr: '', head, published: 'false', reason: `the gate recorded neither a review nor a completed no-commit result for ${head.slice(0, 7)}` });
      return;
    }
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
    if (!samePullRequest(kept, upstream)) throw new Error(`the builder reports ${kept}, but this move continues ${upstream}; nothing is written`);
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

  refuseBaseBranch(branch, review.base);

  const repo = canonicalRepoOfOrigin(git(['remote', 'get-url', 'origin']));
  // origin may push somewhere else than it fetches from; every push destination must be this same repository.
  for (const pushUrl of git(['remote', 'get-url', '--push', '--all', 'origin']).split('\n')) {
    const destination = canonicalRepoOfOrigin(pushUrl);
    if (destination.host !== repo.host || destination.path.toLowerCase() !== repo.path.toLowerCase()) {
      throw new Error(`origin pushes to ${destination.path}, not to ${repo.path}; nothing is pushed`);
    }
  }
  const section = reviewSection(review);
  const bodyPath = join(artifactsDir(), 'pull-request-body.md');

  // The builder gave the continued pull request up; a clean review of what it committed does not override that.
  if (abandonedContinuation(builder, upstream)) {
    emit({ pr: '', head, published: 'false', reason: `the builder reports PR: none for ${upstream}; its commit is not pushed` });
    return;
  }
  // An earlier attempt of this node may have opened the pull request already; find it by its branch.
  const reported = reportLine(builder, 'PR');
  if (upstream !== '' && reported !== undefined && !samePullRequest(reported, upstream)) {
    throw new Error(`the builder reports ${reported}, but this move continues ${upstream}; nothing is pushed`);
  }
  // A pull request this node created in an earlier attempt is remembered here, open or not; the open-PR lookup
  // covers an attempt that died before it could remember.
  const createdPath = join(artifactsDir(), 'pull-request-created.json');
  const earlier = readIf(createdPath);
  const receipt = earlier === undefined ? {} : (JSON.parse(earlier) as { url?: unknown; attempt?: unknown });
  const remembered = typeof receipt.url === 'string' ? receipt.url : '';
  // An attempt recorded without a URL may have created the pull request and died before reading it back; a pull
  // request on this branch in any state is that one, and a closed one is the owner's word against a second.
  const anyState = receipt.attempt !== undefined && remembered === '';
  let url = upstream || reported || remembered || findPrByHead(repo, repo, branch, source, anyState ? 'all' : 'open')?.pr.url || '';
  if (url !== '') {
    const existing = viewPr(pullRefOf(url), source).pr;
    // A pull request merged or closed while Codex reviewed gets no push: its branch is history now.
    if (existing.state !== 'open') {
      emit({ pr: '', head, published: 'false', reason: `${url} is ${existing.state}; the reviewed commit was not pushed` });
      return;
    }
    assertHeadInOrigin(url, existing.head_repo, repo);
    if (existing.head !== branch) throw new Error(`${url} has head ${existing.head}, not the builder's branch ${branch}`);
    // The review diffed against this base; a pull request into another branch is a different change.
    if (existing.base !== review.base) throw new Error(`${url} merges into ${existing.base}, but the review diffed against ${review.base}`);
  }
  // The reviewed commit by its SHA, so a branch that moved meanwhile cannot slip in.
  git(['push', 'origin', `${head}:refs/heads/${branch}`]);
  // A push by SHA leaves the branch's tracking as it was; the builder's next plain push must reach this branch.
  git(['config', `branch.${branch}.remote`, 'origin']);
  git(['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);

  if (url === '') {
    const issue = /\/issues\/(\d+)\/?$/.exec(target)?.[1];
    const body = readIf(join(files, 'body.md')) ?? (issue === undefined ? '' : `Closes #${issue}\n`);
    writeFileSync(bodyPath, withCodexReviewSection(body, section));
    const title = (readIf(join(files, 'title.txt')) ?? git(['log', '-1', '--format=%s'])).trim();
    // The attempt is on record before the forge is asked, so a death between creation and read-back is found again.
    writeFileSync(createdPath, `${JSON.stringify({ attempt: { branch, head } })}\n`);
    const created = createPr(
      { repo, headRepo: repo, head: branch, headRevision: head, base: review.base, title, bodyPath, draft: false },
      source
    );
    url = created.url;
    writeFileSync(createdPath, `${JSON.stringify({ url })}\n`);
  } else {
    const ref = pullRefOf(url);
    const current = viewPr(ref, source);
    // Read again after the push: a pull request closed meanwhile gets no body, comment or ready state.
    if (current.pr.state !== 'open') {
      emit({ pr: '', head, published: 'false', reason: `${url} is ${current.pr.state}; the pushed commit was not published to it` });
      return;
    }
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
