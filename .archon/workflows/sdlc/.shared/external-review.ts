/**
 * Delivery's external review gate: a Copilot or Codex review of the exact
 * pull-request head, at most five correction cycles per pull request, and the
 * ledger that keeps that count across restarts and runs.
 *
 * The gate is opt-in per project. `ARCHON_SDLC_EXTERNAL_REVIEW=copilot` turns it on
 * with Copilot, and `ARCHON_SDLC_GITHUB_LOGIN` names the one GitHub login it may act
 * as. `ARCHON_SDLC_EXTERNAL_REVIEW=codex` turns it on with a local, read-only Codex
 * review of the run's checkout ([`codex-review.ts`](./codex-review.ts)); it acts on
 * GitHub only to read the pull request. Both are read here, not in the calling
 * scripts, for the same reason `forgeSource()` is.
 *
 * Every GitHub operation goes through `gh` whichever forge source the run selected:
 * the forge contract has no review-request operation, the same reason issue writes
 * use `gh`. Nothing here retries a failed read or write. A failure stops the gate
 * with its evidence, because a guessed answer about an external review is a verdict
 * nobody gave.
 *
 * The ledger is the engine's per-project cross-run state (`$STATE_DIR`), not this
 * run's artifacts: a `loop_group` that fails and is resumed restarts at iteration 1,
 * so an iteration bound alone would hand a restarted run five fresh corrections.
 * Every automated merge path asks the same ledger through `externalReviewHold`, so
 * a pull request no Copilot review passed is not merged around the gate.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runGh } from './claims.ts';
import { record, type QualifiedPr } from './forge.ts';
import { artifactsDir, runId, stateDir } from './io.ts';

export const MAX_CORRECTIONS = 5;
export const REVIEW_WAIT_MS = 30 * 60_000;
export const POLL_INTERVAL_MS = 30_000;

/** The policy node's `mode`, first the default. */
export const EXTERNAL_REVIEW_MODES = ['none', 'copilot', 'codex'] as const;
export type ExternalReviewMode = (typeof EXTERNAL_REVIEW_MODES)[number];

export type ExternalReviewPolicy =
  | { readonly mode: Exclude<ExternalReviewMode, 'copilot'> }
  | { readonly mode: Extract<ExternalReviewMode, 'copilot'>; readonly login: string };

function isMode(value: string): value is ExternalReviewMode {
  return (EXTERNAL_REVIEW_MODES as readonly string[]).includes(value);
}

export function externalReviewPolicy(): ExternalReviewPolicy {
  const selected = (process.env.ARCHON_SDLC_EXTERNAL_REVIEW ?? '').trim() || EXTERNAL_REVIEW_MODES[0];
  if (!isMode(selected)) {
    throw new Error(
      `ARCHON_SDLC_EXTERNAL_REVIEW must be one of ${EXTERNAL_REVIEW_MODES.map(mode => `"${mode}"`).join(', ')} (the first is the default), not "${selected}"`
    );
  }
  if (selected !== 'copilot') return { mode: selected };
  const login = (process.env.ARCHON_SDLC_GITHUB_LOGIN ?? '').trim();
  if (login === '') {
    throw new Error(
      'ARCHON_SDLC_EXTERNAL_REVIEW=copilot needs ARCHON_SDLC_GITHUB_LOGIN, the GitHub login the gate may act as'
    );
  }
  return { mode: 'copilot', login };
}

/**
 * The Copilot code review account. GitHub reports one user under two logins: the
 * reviews endpoint says `copilot-pull-request-reviewer[bot]`, review comments and
 * requested reviewers say `Copilot`. The id is github.com's, so another host is
 * refused rather than trusted on a login a site administrator could register.
 */
const COPILOT = {
  host: 'github.com',
  id: 175728472,
  logins: ['Copilot', 'copilot-pull-request-reviewer[bot]'],
  requestAs: 'copilot-pull-request-reviewer[bot]',
} as const;

function isCopilot(user: unknown): boolean {
  const row = record(user);
  return (
    row?.id === COPILOT.id &&
    row.type === 'Bot' &&
    typeof row.login === 'string' &&
    (COPILOT.logins as readonly string[]).includes(row.login)
  );
}

export function pullUrl(ref: QualifiedPr): string {
  return `https://${ref.repo.host}/${ref.repo.path}/pull/${String(ref.number)}`;
}

/** The pull request a `https://<host>/<owner>/<repo>/pull/<n>` URL names. */
export function pullRefOf(url: string): QualifiedPr {
  const match = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url.trim());
  if (!match?.[1] || !match[2] || !match[3]) throw new Error(`${url} is not a pull request URL`);
  return { repo: { host: match[1], path: match[2] }, number: Number(match[3]) };
}

// ── GitHub ────────────────────────────────────────────────────────────────

export interface GitHubRequest {
  readonly method?: 'GET' | 'POST';
  readonly path: string;
  readonly body?: Record<string, unknown>;
  /** A list endpoint: every page, as an array of pages. */
  readonly list?: boolean;
}

/** One REST call that returns parsed JSON or throws with GitHub's own words. */
export type GitHub = (request: GitHubRequest) => unknown;

export const ghApi: GitHub = request => {
  if (request.list) return runGh([request.path, '--paginate', '--slurp']);
  if (request.method !== 'POST') return runGh([request.path]);
  const directory = mkdtempSync(join(tmpdir(), 'archon-external-review-'));
  try {
    const payload = join(directory, 'request.json');
    writeFileSync(payload, JSON.stringify(request.body ?? {}), { mode: 0o600 });
    return runGh([request.path, '--method', 'POST', '--input', payload]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

function list(github: GitHub, path: string): unknown[] {
  const pages = github({ path: `${path}?per_page=100`, list: true });
  if (!Array.isArray(pages) || !pages.every((page): page is unknown[] => Array.isArray(page))) {
    throw new Error(`GitHub returned an unexpected payload for ${path}`);
  }
  return pages.flat();
}

/** Refuses unless the token the gate runs with belongs to the configured login. */
export function assertIdentity(github: GitHub, login: string): void {
  const user = record(github({ path: 'user' }));
  if (typeof user?.login !== 'string') throw new Error('GitHub returned no login for this token');
  if (user.login.toLowerCase() !== login.toLowerCase()) {
    throw new Error(
      `the GitHub token belongs to ${user.login}, not ${login}; the gate acts only as ARCHON_SDLC_GITHUB_LOGIN`
    );
  }
}

export function assertCopilotHost(ref: QualifiedPr): void {
  if (ref.repo.host.toLowerCase() !== COPILOT.host) {
    throw new Error(`Copilot review is supported on ${COPILOT.host} only, not ${ref.repo.host}`);
  }
}

interface Pull {
  readonly state: string;
  readonly head: string;
  /** The branch the pull request merges into. */
  readonly base: string;
  /** Copilot is a requested reviewer that has not yet submitted. */
  readonly pending: boolean;
}

export function readPull(github: GitHub, ref: QualifiedPr): Pull {
  const pull = record(github({ path: `repos/${ref.repo.path}/pulls/${String(ref.number)}` }));
  const head = record(pull?.head);
  const base = record(pull?.base);
  if (
    typeof pull?.state !== 'string' ||
    typeof head?.sha !== 'string' ||
    head.sha === '' ||
    typeof base?.ref !== 'string' ||
    base.ref === '' ||
    !Array.isArray(pull.requested_reviewers)
  ) {
    throw new Error(`GitHub returned an unexpected pull request for ${pullUrl(ref)}`);
  }
  return {
    state: pull.merged === true ? 'merged' : pull.state,
    head: head.sha,
    base: base.ref,
    pending: (pull.requested_reviewers as unknown[]).some(isCopilot),
  };
}

export interface CopilotReview {
  readonly id: string;
  readonly head: string;
  readonly url: string;
  readonly state: string;
  readonly submittedAt: string;
  readonly body: string;
}

const SUBMITTED = new Set(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED']);

/**
 * Copilot's submitted reviews. Other reviewers are not this gate's evidence and are
 * skipped; a Copilot row missing a field the verdict depends on is refused.
 */
export function copilotReviews(rows: readonly unknown[]): CopilotReview[] {
  const reviews: CopilotReview[] = [];
  for (const value of rows) {
    const row = record(value);
    if (!isCopilot(row?.user) || !SUBMITTED.has(String(row?.state))) continue;
    if (
      typeof row?.id !== 'number' ||
      typeof row.commit_id !== 'string' ||
      row.commit_id === '' ||
      typeof row.html_url !== 'string' ||
      typeof row.submitted_at !== 'string' ||
      !(typeof row.body === 'string' || row.body === null)
    ) {
      throw new Error('GitHub returned a Copilot review without its id, commit, link or time');
    }
    reviews.push({
      id: String(row.id),
      head: row.commit_id,
      url: row.html_url,
      state: String(row.state),
      submittedAt: row.submitted_at,
      body: row.body ?? '',
    });
  }
  return reviews;
}

/** The newest review of exactly `head`: a review of an earlier commit is stale. */
export function latestReviewOf(reviews: readonly CopilotReview[], head: string): CopilotReview | undefined {
  return reviews
    .filter(review => review.head === head)
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || Number(a.id) - Number(b.id))
    .at(-1);
}

export interface ReviewComment {
  readonly id: string;
  readonly path: string;
  readonly line: number | null;
  readonly url: string;
  readonly body: string;
}

function reviewComments(github: GitHub, ref: QualifiedPr, review: string): ReviewComment[] {
  return list(
    github,
    `repos/${ref.repo.path}/pulls/${String(ref.number)}/reviews/${review}/comments`
  ).map(value => {
    const row = record(value);
    if (
      typeof row?.id !== 'number' ||
      typeof row.path !== 'string' ||
      !(typeof row.line === 'number' || row.line === null || row.line === undefined) ||
      typeof row.html_url !== 'string' ||
      typeof row.body !== 'string'
    ) {
      throw new Error(`GitHub returned an unexpected comment on Copilot review ${review}`);
    }
    return {
      id: String(row.id),
      path: row.path,
      line: typeof row.line === 'number' ? row.line : null,
      url: row.html_url,
      body: row.body,
    };
  });
}

/**
 * Ask for a Copilot review of `head`. The receipt must name this pull request and
 * head; its `requested_reviewers` is not evidence either way, since GitHub answers
 * an accepted Copilot request with an empty list and the review arrives later.
 */
function requestCopilot(github: GitHub, ref: QualifiedPr, head: string): void {
  const receipt = record(
    github({
      method: 'POST',
      path: `repos/${ref.repo.path}/pulls/${String(ref.number)}/requested_reviewers`,
      body: { reviewers: [COPILOT.requestAs] },
    })
  );
  const receiptHead = record(receipt?.head)?.sha;
  if (receipt?.number !== ref.number || receiptHead !== head) {
    throw new Error(
      `GitHub's receipt for the review request names pull ${String(receipt?.number)} at ${String(receiptHead)}, not ${pullUrl(ref)} at ${head}`
    );
  }
}

// ── Ledger ────────────────────────────────────────────────────────────────

export const VERDICTS = [
  'clean',
  'adjudicated',
  'correct',
  'unavailable',
  'exhausted',
  'claimed',
  'blocked',
] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The verdicts that let delivery continue: the route node's `action`. */
export const ROUTE_ACTIONS = ['clean', 'adjudicated', 'correct'] as const;
export type RouteAction = (typeof ROUTE_ACTIONS)[number];

/** The triage agent's reading of a review: Copilot reviewed the change, or did not. */
export const TRIAGE_OUTCOMES = ['reviewed', 'unavailable'] as const;

/**
 * A request is `attempted` before the POST and `accepted` once GitHub's receipt is
 * read, so a crash or a lost response between the two never sends a second request.
 * The first `attempted` for a head owns its request; a later one, from a run that
 * raced it, sends nothing.
 */
export const RECEIPTS = ['attempted', 'accepted'] as const;
export type Receipt = (typeof RECEIPTS)[number];

interface Stamp {
  readonly at: string;
  readonly run: string;
}
export type LedgerEvent =
  | (Stamp & { readonly event: 'requested'; readonly head: string; readonly receipt: Receipt })
  | (Stamp & {
      readonly event: 'verdict';
      readonly review: string;
      readonly head: string;
      readonly verdict: Verdict;
      readonly findings: number;
    })
  | (Stamp & { readonly event: 'verified'; readonly review: string; readonly head: string });

type Unstamped<T> = T extends unknown ? Omit<T, keyof Stamp> : never;

function parseEvent(line: string, index: number, path: string): LedgerEvent {
  let value: Record<string, unknown> | undefined;
  try {
    value = record(JSON.parse(line));
  } catch {
    value = undefined;
  }
  const text = (field: unknown): field is string => typeof field === 'string' && field !== '';
  const valid =
    value !== undefined &&
    text(value.at) &&
    typeof value.run === 'string' &&
    text(value.head) &&
    ((value.event === 'requested' && (RECEIPTS as readonly unknown[]).includes(value.receipt)) ||
      (value.event === 'verified' && text(value.review)) ||
      (value.event === 'verdict' &&
        text(value.review) &&
        (VERDICTS as readonly unknown[]).includes(value.verdict) &&
        typeof value.findings === 'number'));
  if (!valid) throw new Error(`the external review ledger ${path} has an unreadable line ${String(index + 1)}`);
  return value as unknown as LedgerEvent;
}

/**
 * One pull request's append-only event log. Appends of one short line stay whole
 * under concurrent writers, so two runs on the same pull request lose no event and
 * read back one order; every fact is folded from the whole log on read. A claim on
 * something only one run may do, the review request and a correction cycle, is
 * appended first and settled by that order (`claimRequest`, `recordVerdict`), never
 * by a state read before the write. That is why every event names its run.
 */
export class Ledger {
  constructor(
    readonly path: string,
    private readonly run: string,
    private readonly now: () => number = Date.now
  ) {}

  static forPull(stateDir: string, ref: QualifiedPr, run: string): Ledger {
    const [owner, repo] = ref.repo.path.toLowerCase().split('/');
    return new Ledger(
      join(
        stateDir,
        'sdlc-external-review',
        ref.repo.host.toLowerCase(),
        owner ?? '',
        repo ?? '',
        `pull-${String(ref.number)}.jsonl`
      ),
      run
    );
  }

  events(): LedgerEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .flatMap((line, index) => (line.trim() === '' ? [] : [parseEvent(line, index, this.path)]));
  }

  append(event: Unstamped<LedgerEvent>): void {
    if (this.run === '') {
      throw new Error(`no run is named for ${this.path}; claims are settled by run, so WORKFLOW_ID must be set`);
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const stamped = { ...event, at: new Date(this.now()).toISOString(), run: this.run };
    appendFileSync(this.path, `${JSON.stringify(stamped)}\n`);
  }

  /** How far the request for `head` got: no request, attempted, or accepted by GitHub. */
  request(head: string): Receipt | undefined {
    const receipts = this.events().flatMap(event =>
      event.event === 'requested' && event.head === head ? [event.receipt] : []
    );
    return receipts.includes('accepted') ? 'accepted' : receipts.at(0);
  }

  /** Record an attempt to request a review of `head`; true when this run's attempt came first. */
  claimRequest(head: string): boolean {
    this.append({ event: 'requested', head, receipt: 'attempted' });
    const first = this.events().find(event => event.event === 'requested' && event.head === head);
    return first?.run === this.run;
  }

  verified(review: string): boolean {
    return this.events().some(event => event.event === 'verified' && event.review === review);
  }

  private verdicts(): Extract<LedgerEvent, { event: 'verdict' }>[] {
    return this.events().filter(
      (event): event is Extract<LedgerEvent, { event: 'verdict' }> => event.event === 'verdict'
    );
  }

  hasVerdict(review: string, verdict: Verdict): boolean {
    return this.verdicts().some(event => event.review === review && event.verdict === verdict);
  }

  /**
   * The reviews that hold a correction cycle, each with the run that holds it: the
   * first five distinct reviews, in log order, with a `correct` verdict, held by the
   * run of that first claim. A resumed run keeps its own cycle; another run's claim
   * on the same review, or on a sixth, holds none.
   */
  private admitted(): Map<string, string> {
    const admitted = new Map<string, string>();
    for (const event of this.verdicts()) {
      if (event.verdict === 'correct' && !admitted.has(event.review) && admitted.size < MAX_CORRECTIONS) {
        admitted.set(event.review, event.run);
      }
    }
    return admitted;
  }

  correctionsUsed(): number {
    return this.admitted().size;
  }

  /**
   * The review whose correction cycle no internal review has passed yet: the last
   * cycle started, unless a `verified` event for it follows. A failed recheck leaves
   * it open, so the internal review's blockers outlive a resume that starts over at
   * a fresh Copilot review.
   */
  unverifiedCorrection(): string | undefined {
    const admitted = this.admitted();
    let open: string | undefined;
    for (const event of this.events()) {
      if (event.event === 'verdict' && event.verdict === 'correct' && admitted.get(event.review) === event.run) {
        open = event.review;
      } else if (event.event === 'verified' && event.review === open) {
        open = undefined;
      }
    }
    return open;
  }

  /**
   * Record a route verdict. A `correct` verdict is a claim on a correction cycle, and
   * this ledger alone settles it, by the log's order: two runs that both decided to
   * correct both append and read back the same order. Only the run that holds the
   * review's cycle corrects. A run that lost that review to another run records
   * `claimed`; one that found every cycle held records `exhausted`. A crash between
   * those two appends leaves a claim the fold already discounts.
   */
  recordVerdict(event: Omit<Extract<LedgerEvent, { event: 'verdict' }>, keyof Stamp | 'event'>): {
    verdict: Verdict;
    corrections: number;
  } {
    this.append({ event: 'verdict', ...event });
    const admitted = this.admitted();
    const holder = admitted.get(event.review);
    if (event.verdict !== 'correct' || holder === this.run) {
      return { verdict: event.verdict, corrections: admitted.size };
    }
    const verdict = holder === undefined ? 'exhausted' : 'claimed';
    this.append({ event: 'verdict', ...event, verdict });
    return { verdict, corrections: admitted.size };
  }

  /** The run that holds the correction cycle for `review`, if any does. */
  correctionHolder(review: string): string | undefined {
    return this.admitted().get(review);
  }

  /**
   * The head carries a passing verdict, nothing after it said otherwise, and no
   * correction cycle is waiting for its internal review.
   */
  ready(head: string): boolean {
    const last = this.verdicts()
      .filter(event => event.head === head)
      .at(-1);
    return (
      (last?.verdict === 'clean' || last?.verdict === 'adjudicated') &&
      this.unverifiedCorrection() === undefined
    );
  }
}

/**
 * Why an automated merge of `url` at `head` must wait for the external review gate,
 * or undefined when it may go ahead. Off by policy means no hold. Anything the gate
 * cannot confirm holds: only the delivery workflow's gate records a passing review,
 * so a pull request built any other way is routed back through it.
 */
export function externalReviewHold(url: string, head: string): string | undefined {
  try {
    const { mode } = externalReviewPolicy();
    if (mode === 'none') return undefined;
    const ref = pullRefOf(url);
    if (mode === 'copilot') assertCopilotHost(ref);
    if (Ledger.forPull(stateDir(), ref, runId()).ready(head)) return undefined;
    return `the external review gate has no passing ${reviewerName()} review of ${url} at ${head}; deliver it through archon-deliver, whose gate records one`;
  } catch (error) {
    return `the external review gate could not confirm ${url}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── Observe ───────────────────────────────────────────────────────────────

export interface Observation {
  readonly review: CopilotReview;
  readonly comments: readonly ReviewComment[];
}

export interface ObserveOptions {
  readonly github: GitHub;
  readonly ledger: Ledger;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly waitMs: number;
  readonly pollMs: number;
}

/**
 * Wait for a submitted Copilot review of exactly `head`, requesting one at most
 * once per head across every run: a run whose claim on the request came second
 * waits for the review the first one asked for.
 *
 * A pending request is never a verdict: while Copilot is still a requested
 * reviewer, even an earlier review of the same head is not yet the latest word. A
 * review the gate already judged unavailable is not reused; it waits for a new
 * request. A head that moves while waiting refuses, since nothing this node did
 * moved it.
 */
export async function observeCopilotReview(
  ref: QualifiedPr,
  head: string,
  options: ObserveOptions
): Promise<Observation> {
  const { github, ledger } = options;
  const deadline = options.now() + options.waitMs;
  const reviewsPath = `repos/${ref.repo.path}/pulls/${String(ref.number)}/reviews`;
  for (;;) {
    const pull = readPull(github, ref);
    if (pull.state !== 'open') throw new Error(`${pullUrl(ref)} is ${pull.state}, not open`);
    if (pull.head !== head) {
      throw new Error(
        `the head of ${pullUrl(ref)} moved from ${head} to ${pull.head} while the gate waited; this run did not push it`
      );
    }
    if (!pull.pending) {
      const latest = latestReviewOf(copilotReviews(list(github, reviewsPath)), head);
      if (latest && !ledger.hasVerdict(latest.id, 'unavailable')) {
        return { review: latest, comments: reviewComments(github, ref, latest.id) };
      }
      if (latest) {
        throw new Error(
          `Copilot's latest review of ${head} (${latest.url}) did not review the change, and no new review is pending; request a Copilot review on the pull request, then resume this run`
        );
      }
      if (ledger.request(head) === undefined && ledger.claimRequest(head)) {
        try {
          requestCopilot(github, ref, head);
        } catch (error) {
          throw new Error(
            `the review request on ${pullUrl(ref)} failed or its receipt was lost, so whether GitHub applied it is unknown (${error instanceof Error ? error.message : String(error)}); the attempt is recorded, so a resumed run waits for a review instead of requesting again`
          );
        }
        ledger.append({ event: 'requested', head, receipt: 'accepted' });
      }
    }
    if (options.now() >= deadline) {
      throw new Error(
        `no Copilot review of ${head} arrived within ${String(Math.round(options.waitMs / 60_000))} minutes (${requestState(pull.pending, ledger.request(head))}); once a review of this head is submitted, or after requesting one on the pull request, resume this run`
      );
    }
    await options.sleep(options.pollMs);
  }
}

function requestState(pending: boolean, receipt: Receipt | undefined): string {
  if (pending) return 'the request is still pending';
  if (receipt === 'accepted') {
    return 'GitHub accepted the request and no longer lists Copilot as pending; its review may still arrive, or Copilot may not run';
  }
  if (receipt === 'attempted') {
    return 'a request was attempted but its receipt was never read, so whether GitHub applied it is unknown';
  }
  return 'Copilot is not a requested reviewer';
}

// ── Route ─────────────────────────────────────────────────────────────────

export interface Finding {
  readonly id: string;
  readonly source: 'inline' | 'overview';
  readonly text: string;
  readonly path?: string;
  readonly line?: number | null;
  readonly url?: string;
}

/** Every inline comment is a finding; the overview adds the concerns no comment carries. */
export function findingsOf(
  comments: readonly ReviewComment[],
  overview: readonly string[],
  reviewer = 'copilot'
): Finding[] {
  return [
    ...comments.map(comment => ({
      id: `${reviewer}-c${comment.id}`,
      source: 'inline' as const,
      text: comment.body,
      path: comment.path,
      line: comment.line,
      url: comment.url,
    })),
    ...overview.map((text, index) => ({
      id: `${reviewer}-o${String(index + 1)}`,
      source: 'overview' as const,
      text,
    })),
  ];
}

export interface RouteInput {
  readonly review: string;
  readonly outcome: (typeof TRIAGE_OUTCOMES)[number];
  readonly findings: readonly Finding[];
  readonly allowCorrection: boolean;
  readonly ledger: Ledger;
}

/**
 * What the review on the current head lets delivery do. `correct` is only a claim:
 * `recordVerdict` decides whether this run may spend a cycle on it.
 *
 * `adjudicated` is the one passing verdict with findings: the correction cycle for
 * this exact review already ran, changed nothing because every finding was declined
 * with evidence, and the internal review verified those declines. A correction that
 * changed code moved the head, so its review is never this one. Nothing passes while
 * an earlier correction waits for its internal review: that cycle's blockers are
 * still open, however clean the newer review is.
 */
export function decide(input: RouteInput): Verdict {
  if (input.outcome === 'unavailable') return 'unavailable';
  const settled = input.ledger.unverifiedCorrection() === undefined;
  if (settled && input.findings.length === 0) return 'clean';
  if (settled && input.ledger.verified(input.review)) return 'adjudicated';
  return input.allowCorrection ? 'correct' : 'blocked';
}

// ── Artifacts ─────────────────────────────────────────────────────────────

/** The reviewer the policy selects, for ids and prose; Copilot while the gate is off. */
export function reviewerOf(): 'copilot' | 'codex' {
  return (process.env.ARCHON_SDLC_EXTERNAL_REVIEW ?? '').trim() === 'codex' ? 'codex' : 'copilot';
}

export function reviewerName(): string {
  return reviewerOf() === 'codex' ? 'Codex' : 'Copilot';
}

export interface Feedback {
  readonly pr: QualifiedPr;
  readonly head: string;
  readonly review: Omit<CopilotReview, 'head'>;
  readonly comments: readonly ReviewComment[];
}

export function externalReviewDir(artifacts: string): string {
  return join(artifacts, 'external-review');
}

/**
 * Record an observed review for the nodes after it: the feedback the triage agent
 * reads, and a report saying triage comes next, since that agent can fail without a
 * script to report it.
 */
export function writeObservation(
  artifacts: string,
  ledger: Ledger,
  ref: QualifiedPr,
  observed: Observation
): void {
  const { head, ...review } = observed.review;
  const dir = externalReviewDir(artifacts);
  mkdirSync(dir, { recursive: true });
  const feedback: Feedback = { pr: ref, head, review, comments: observed.comments };
  writeFileSync(join(dir, 'feedback.json'), `${JSON.stringify(feedback, null, 2)}\n`);
  writeReport(artifacts, ledger, {
    ref,
    status: 'observed',
    reason:
      reviewerOf() === 'codex'
        ? `Codex review ${review.id} of ${head} was observed and the route reads it next`
        : `Copilot review ${review.id} of ${head} was observed and the triage agent reads it next; if the run stopped after this report, that triage failed and no verdict was recorded`,
    head,
    reviewUrl: review.url,
  });
}

export function readFeedback(artifacts: string, review: string, head: string): Feedback {
  const path = join(externalReviewDir(artifacts), 'feedback.json');
  let feedback: Feedback;
  try {
    feedback = JSON.parse(readFileSync(path, 'utf8')) as Feedback;
  } catch {
    throw new Error(`${path} is missing or unreadable`);
  }
  if (feedback.review?.id !== review || feedback.head !== head || !Array.isArray(feedback.comments)) {
    throw new Error(`${path} does not describe review ${review} of ${head}`);
  }
  return feedback;
}

/**
 * `unverified_correction` names an earlier Copilot review whose correction no
 * internal review passed: that review's open blockers are this cycle's work too.
 */
export function writeFindings(
  artifacts: string,
  feedback: Feedback,
  findings: readonly Finding[],
  unverifiedCorrection: string | undefined
): void {
  writeFileSync(
    join(externalReviewDir(artifacts), 'findings.json'),
    `${JSON.stringify(
      {
        reviewer: reviewerOf(),
        head: feedback.head,
        review: feedback.review.id,
        url: feedback.review.url,
        unverified_correction: unverifiedCorrection ?? null,
        findings,
      },
      null,
      2
    )}\n`
  );
}

export interface ReportState {
  readonly ref: QualifiedPr;
  readonly status: string;
  readonly reason: string;
  readonly head?: string;
  readonly reviewUrl?: string;
  readonly findings?: readonly Finding[];
}

function historyLine(event: LedgerEvent): string {
  switch (event.event) {
    case 'verdict':
      return `- ${event.at} review ${event.review} of ${event.head}: ${event.verdict} by run ${event.run} (${String(event.findings)} findings)`;
    case 'requested':
      return `- ${event.at} review request for ${event.head}: ${event.receipt}`;
    case 'verified':
      return `- ${event.at} correction for review ${event.review} verified by the internal review at ${event.head}`;
  }
}

/**
 * The durable report the operator opens when the gate stops. It is written on every
 * verdict, before every stage that can fail, and before every refusal, so the newest
 * file always says where things stand.
 */
export function writeReport(artifacts: string, ledger: Ledger, state: ReportState): void {
  const dir = externalReviewDir(artifacts);
  mkdirSync(dir, { recursive: true });
  let history: string[];
  let corrections: string;
  let unverified: string;
  try {
    history = ledger.events().map(historyLine);
    corrections = `${String(ledger.correctionsUsed())} of ${String(MAX_CORRECTIONS)}`;
    const open = ledger.unverifiedCorrection();
    unverified = open === undefined ? 'none' : `review ${open} (no internal review has passed it)`;
  } catch (error) {
    history = [`- the ledger could not be read: ${error instanceof Error ? error.message : String(error)}`];
    corrections = 'unknown (the ledger could not be read)';
    unverified = 'unknown (the ledger could not be read)';
  }
  const findings = state.findings ?? [];
  const lines = [
    `# External review (${reviewerName()})`,
    '',
    `- Pull request: ${pullUrl(state.ref)}`,
    `- Status: ${state.status}`,
    `- Reason: ${state.reason}`,
    `- Head: ${state.head ?? 'unknown'}`,
    `- Review: ${state.reviewUrl ?? 'none observed'}`,
    `- Corrections used: ${corrections}`,
    `- Unverified correction: ${unverified}`,
    `- Ledger: ${ledger.path}`,
    '',
    `## Findings on this review (${String(findings.length)})`,
    '',
    ...(findings.length === 0
      ? ['None.']
      : findings.map(
          finding =>
            `- ${finding.id} (${finding.source}${finding.path ? `, ${finding.path}${finding.line ? `:${String(finding.line)}` : ''}` : ''}): ${finding.text.replace(/\s+/g, ' ').trim()}`
        )),
    '',
    '## History',
    '',
    ...(history.length === 0 ? ['No events yet.'] : history),
    '',
  ];
  writeFileSync(join(dir, 'report.md'), lines.join('\n'));
}

/**
 * Write the stop report and return the reason to refuse with. A report that cannot
 * be written is added to the reason rather than replacing it.
 */
export function reportStop(ledger: Ledger, state: ReportState): string {
  try {
    writeReport(artifactsDir(), ledger, state);
    return `${state.reason.replace(/\.+$/, '')}; see ${join(externalReviewDir(artifactsDir()), 'report.md')}`;
  } catch (error) {
    return `${state.reason} (the external review report could not be written: ${error instanceof Error ? error.message : String(error)})`;
  }
}
