/**
 * Delivery's external review gate: a Copilot review of the exact pull-request head,
 * at most five correction cycles per pull request, and the ledger that keeps that
 * count across restarts and runs.
 *
 * The gate is opt-in per project. `ARCHON_SDLC_EXTERNAL_REVIEW=copilot` turns it on,
 * and `ARCHON_SDLC_GITHUB_LOGIN` names the one GitHub login it may act as. Both are
 * read here, not in the calling scripts, for the same reason `forgeSource()` is.
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
import { record, type QualifiedPr } from './forge.ts';

export const MAX_CORRECTIONS = 5;
export const REVIEW_WAIT_MS = 30 * 60_000;
export const POLL_INTERVAL_MS = 30_000;

export type ExternalReviewPolicy =
  | { readonly mode: 'none' }
  | { readonly mode: 'copilot'; readonly login: string };

export function externalReviewPolicy(): ExternalReviewPolicy {
  const selected = (process.env.ARCHON_SDLC_EXTERNAL_REVIEW ?? '').trim();
  if (selected === '' || selected === 'none') return { mode: 'none' };
  if (selected !== 'copilot') {
    throw new Error(
      `ARCHON_SDLC_EXTERNAL_REVIEW must be "none" (the default) or "copilot", not "${selected}"`
    );
  }
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

// ── GitHub ────────────────────────────────────────────────────────────────

export interface GitHubRequest {
  readonly method?: 'GET' | 'POST';
  readonly path: string;
  readonly body?: Record<string, unknown>;
}

/** One REST call that returns parsed JSON or throws with GitHub's own words. */
export type GitHub = (request: GitHubRequest) => unknown;

export function ghApi(host: string): GitHub {
  return request => {
    const args = ['api', '--hostname', host];
    let directory: string | undefined;
    if (request.method === 'POST') {
      directory = mkdtempSync(join(tmpdir(), 'archon-external-review-'));
      const payload = join(directory, 'request.json');
      writeFileSync(payload, JSON.stringify(request.body ?? {}), { mode: 0o600 });
      args.push('--method', 'POST', '--input', payload);
    }
    try {
      // Captured, never inherited: a node's stderr reaches the operator, and gh is
      // chatty there.
      const result = Bun.spawnSync(['gh', ...args, request.path], { stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode !== 0) {
        throw new Error(`gh api ${request.path} failed: ${result.stderr.toString().trim()}`);
      }
      try {
        return JSON.parse(result.stdout.toString()) as unknown;
      } catch {
        throw new Error(`gh api ${request.path} returned invalid JSON`);
      }
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  };
}

function pages(github: GitHub, path: string): unknown[] {
  const rows: unknown[] = [];
  for (let page = 1; ; page++) {
    const batch = github({ path: `${path}?per_page=100&page=${String(page)}` });
    if (!Array.isArray(batch)) throw new Error(`GitHub returned an unexpected payload for ${path}`);
    rows.push(...(batch as unknown[]));
    if (batch.length < 100) return rows;
  }
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
  /** Copilot is a requested reviewer that has not yet submitted. */
  readonly pending: boolean;
}

export function readPull(github: GitHub, ref: QualifiedPr): Pull {
  const pull = record(github({ path: `repos/${ref.repo.path}/pulls/${String(ref.number)}` }));
  const head = record(pull?.head);
  if (
    typeof pull?.state !== 'string' ||
    typeof head?.sha !== 'string' ||
    head.sha === '' ||
    !Array.isArray(pull.requested_reviewers)
  ) {
    throw new Error(`GitHub returned an unexpected pull request for ${pullUrl(ref)}`);
  }
  return {
    state: pull.merged === true ? 'merged' : pull.state,
    head: head.sha,
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
  return pages(
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

function requestCopilot(github: GitHub, ref: QualifiedPr): void {
  const response = record(
    github({
      method: 'POST',
      path: `repos/${ref.repo.path}/pulls/${String(ref.number)}/requested_reviewers`,
      body: { reviewers: [COPILOT.requestAs] },
    })
  );
  const requested = response?.requested_reviewers;
  if (!Array.isArray(requested) || !(requested as unknown[]).some(isCopilot)) {
    throw new Error(
      `GitHub accepted the review request on ${pullUrl(ref)} but does not list Copilot as a requested reviewer; Copilot code review may be unavailable to this account on this repository`
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
  'blocked',
] as const;
export type Verdict = (typeof VERDICTS)[number];

interface Stamp {
  readonly at: string;
  readonly run: string;
}
export type LedgerEvent =
  | (Stamp & { readonly event: 'requested'; readonly head: string })
  | (Stamp & {
      readonly event: 'verdict';
      readonly review: string;
      readonly head: string;
      readonly verdict: Verdict;
      readonly findings: number;
      readonly corrections: number;
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
    (value.event === 'requested' ||
      (value.event === 'verified' && text(value.review)) ||
      (value.event === 'verdict' &&
        text(value.review) &&
        (VERDICTS as readonly unknown[]).includes(value.verdict) &&
        typeof value.findings === 'number' &&
        typeof value.corrections === 'number'));
  if (!valid) throw new Error(`the external review ledger ${path} has an unreadable line ${String(index + 1)}`);
  return value as unknown as LedgerEvent;
}

/**
 * One pull request's append-only event log. Appends of one short line stay whole
 * under concurrent writers, so two runs on the same pull request lose no event;
 * every fact is folded from the whole log on read.
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
    mkdirSync(dirname(this.path), { recursive: true });
    const stamped = { ...event, at: new Date(this.now()).toISOString(), run: this.run };
    appendFileSync(this.path, `${JSON.stringify(stamped)}\n`);
  }

  requested(head: string): boolean {
    return this.events().some(event => event.event === 'requested' && event.head === head);
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

  /** Distinct reviews that started a correction: a rerun of one cycle counts once. */
  correctionsUsed(): number {
    return new Set(
      this.verdicts()
        .filter(event => event.verdict === 'correct')
        .map(event => event.review)
    ).size;
  }

  /** The head carries a passing verdict and nothing after it said otherwise. */
  ready(head: string): boolean {
    const last = this.verdicts()
      .filter(event => event.head === head)
      .at(-1);
    return last?.verdict === 'clean' || last?.verdict === 'adjudicated';
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
 * once per head.
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
      const latest = latestReviewOf(copilotReviews(pages(github, reviewsPath)), head);
      if (latest && !ledger.hasVerdict(latest.id, 'unavailable')) {
        return { review: latest, comments: reviewComments(github, ref, latest.id) };
      }
      if (latest) {
        throw new Error(
          `Copilot's latest review of ${head} (${latest.url}) did not review the change, and no new review is pending; request a Copilot review on the pull request, then resume this run`
        );
      }
      if (!ledger.requested(head)) {
        requestCopilot(github, ref);
        ledger.append({ event: 'requested', head });
      }
    }
    if (options.now() >= deadline) {
      throw new Error(
        `no Copilot review of ${head} arrived within ${String(Math.round(options.waitMs / 60_000))} minutes (${pull.pending ? 'the request is still pending' : 'Copilot is not a requested reviewer'}); once a review of this head is submitted, or after requesting one on the pull request, resume this run`
      );
    }
    await options.sleep(options.pollMs);
  }
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
  overview: readonly string[]
): Finding[] {
  return [
    ...comments.map(comment => ({
      id: `copilot-c${comment.id}`,
      source: 'inline' as const,
      text: comment.body,
      path: comment.path,
      line: comment.line,
      url: comment.url,
    })),
    ...overview.map((text, index) => ({
      id: `copilot-o${String(index + 1)}`,
      source: 'overview' as const,
      text,
    })),
  ];
}

export interface RouteInput {
  readonly review: string;
  readonly outcome: 'reviewed' | 'unavailable';
  readonly findings: readonly Finding[];
  readonly allowCorrection: boolean;
  readonly ledger: Ledger;
}

/**
 * What the review on the current head lets delivery do.
 *
 * `adjudicated` is the one passing verdict with findings: the correction cycle for
 * this exact review already ran, changed nothing because every finding was declined
 * with evidence, and the internal review verified those declines. A correction that
 * changed code moved the head, so its review is never this one.
 */
export function decide(input: RouteInput): { verdict: Verdict; corrections: number } {
  const used = input.ledger.correctionsUsed();
  if (input.outcome === 'unavailable') return { verdict: 'unavailable', corrections: used };
  if (input.findings.length === 0) return { verdict: 'clean', corrections: used };
  if (input.ledger.verified(input.review)) return { verdict: 'adjudicated', corrections: used };
  if (!input.allowCorrection) return { verdict: 'blocked', corrections: used };
  if (input.ledger.hasVerdict(input.review, 'correct')) return { verdict: 'correct', corrections: used };
  if (used >= MAX_CORRECTIONS) return { verdict: 'exhausted', corrections: used };
  return { verdict: 'correct', corrections: used + 1 };
}

// ── Artifacts ─────────────────────────────────────────────────────────────

export interface Feedback {
  readonly pr: QualifiedPr;
  readonly head: string;
  readonly review: Omit<CopilotReview, 'head'>;
  readonly comments: readonly ReviewComment[];
}

export function externalReviewDir(artifacts: string): string {
  return join(artifacts, 'external-review');
}

export function writeFeedback(artifacts: string, feedback: Feedback): void {
  const dir = externalReviewDir(artifacts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'feedback.json'), `${JSON.stringify(feedback, null, 2)}\n`);
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

export function writeFindings(
  artifacts: string,
  feedback: Feedback,
  findings: readonly Finding[]
): void {
  writeFileSync(
    join(externalReviewDir(artifacts), 'findings.json'),
    `${JSON.stringify(
      {
        reviewer: 'copilot',
        head: feedback.head,
        review: feedback.review.id,
        url: feedback.review.url,
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

/**
 * The durable report the operator opens when the gate stops: written before every
 * refusal and on every verdict, so the newest file always says where things stand.
 */
export function writeReport(artifacts: string, ledger: Ledger, state: ReportState): void {
  const dir = externalReviewDir(artifacts);
  mkdirSync(dir, { recursive: true });
  let history: string[];
  try {
    history = ledger
      .events()
      .map(event =>
        event.event === 'verdict'
          ? `- ${event.at} review ${event.review} of ${event.head}: ${event.verdict} (${String(event.findings)} findings, ${String(event.corrections)}/${String(MAX_CORRECTIONS)} corrections)`
          : `- ${event.at} ${event.event} ${event.head}`
      );
  } catch (error) {
    history = [`- the ledger could not be read: ${error instanceof Error ? error.message : String(error)}`];
  }
  let corrections: string;
  try {
    corrections = `${String(ledger.correctionsUsed())} of ${String(MAX_CORRECTIONS)}`;
  } catch {
    corrections = 'unknown (the ledger could not be read)';
  }
  const findings = state.findings ?? [];
  const lines = [
    '# External review (Copilot)',
    '',
    `- Pull request: ${pullUrl(state.ref)}`,
    `- Status: ${state.status}`,
    `- Reason: ${state.reason}`,
    `- Head: ${state.head ?? 'unknown'}`,
    `- Review: ${state.reviewUrl ?? 'none observed'}`,
    `- Corrections used: ${corrections}`,
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
