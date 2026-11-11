/**
 * The external review gate against synthetic GitHub data.
 *
 * The observation, the routing decision and the ledger are exercised in process
 * through an injected GitHub client and clock, so a 30-minute wait costs nothing
 * and every request the gate makes is visible. The node scripts run as
 * subprocesses only where the script's own refusal and report are the subject.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  Ledger,
  MAX_CORRECTIONS,
  assertCopilotHost,
  assertIdentity,
  ROUTE_ACTIONS,
  TRIAGE_OUTCOMES,
  decide,
  EXTERNAL_REVIEW_MODES,
  externalReviewHold,
  externalReviewPolicy,
  findingsOf,
  ghApi,
  observeCopilotReview,
  writeObservation,
  type GitHub,
  type GitHubRequest,
  type Observation,
  type Receipt,
} from '../../workflows/sdlc/.shared/external-review';
import type { QualifiedPr } from '../../workflows/sdlc/.shared/forge';
import { PR_URL, runDeliverScript, runPackScript, type ScriptRun } from './deliver-checks-harness';

// The scripted Codex of these tests is found through PATH; a developer's own pin must not take its place.
process.env.CODEX_BIN_PATH = '';
const trackTempRoot = trackTempRoots();
/** Commits made here and by the land script read no user or system git config. */
const GIT_ISOLATION = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, ...GIT_ISOLATION } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
const REF: QualifiedPr = { repo: { host: 'github.com', path: 'example/repo' }, number: 7 };
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const COPILOT_REVIEWER = { id: 175728472, login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
const COPILOT_REQUESTED = { id: 175728472, login: 'Copilot', type: 'Bot' };
const MINUTE = 60_000;

function scratch(): string {
  return trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-external-review-')));
}

function ledger(dir = scratch(), run = 'run-1'): Ledger {
  return Ledger.forPull(dir, REF, run);
}

interface ReviewRow {
  id: number;
  user: object;
  state: string;
  commit_id: string;
  html_url: string;
  submitted_at: string;
  body: string | null;
}

function review(id: number, head: string, minute: number, user: object = COPILOT_REVIEWER): ReviewRow {
  return {
    id,
    user,
    state: 'COMMENTED',
    commit_id: head,
    html_url: `${PR_URL}#review-${String(id)}`,
    submitted_at: new Date(Date.UTC(2026, 10, 2, 10, minute)).toISOString(),
    body: '### Changes recommended',
  };
}

/** One pull request's GitHub state; every request the gate makes is recorded. */
class FakeGitHub {
  state = 'open';
  head = HEAD;
  requested: object[] = [];
  reviews: ReviewRow[] = [];
  comments = new Map<number, object[]>();
  login = 'shami13';
  requestListsCopilot = true;
  /** The POST is applied, but its response never reaches the gate. */
  loseReceipt = false;
  /** Runs when the POST reaches GitHub, before its receipt returns. */
  onPost: (() => void) | undefined;
  failOn: string | undefined;
  readonly calls: GitHubRequest[] = [];

  readonly api: GitHub = request => {
    this.calls.push(request);
    if (this.failOn !== undefined && request.path.includes(this.failOn)) {
      throw new Error(`gh api ${request.path} failed: HTTP 403: API rate limit exceeded`);
    }
    const base = `repos/${REF.repo.path}/pulls/${String(REF.number)}`;
    const path = request.path.split('?')[0];
    if (path === 'user') return { login: this.login };
    if (path === base) {
      return { state: this.state, head: { sha: this.head }, base: { ref: 'main' }, requested_reviewers: this.requested };
    }
    if (path === `${base}/requested_reviewers` && request.method === 'POST') {
      this.onPost?.();
      this.requested = this.requestListsCopilot ? [COPILOT_REQUESTED] : [];
      if (this.loseReceipt) throw new Error('gh api requested_reviewers: connection reset');
      return { number: REF.number, head: { sha: this.head }, requested_reviewers: this.requested };
    }
    if (path === `${base}/reviews` && request.list) return [this.reviews];
    const comments = /\/reviews\/(\d+)\/comments$/.exec(path);
    if (comments && request.list) return [this.comments.get(Number(comments[1])) ?? []];
    throw new Error(`unexpected request ${request.path}`);
  };

  posts(): number {
    return this.calls.filter(call => call.method === 'POST').length;
  }

  /** Copilot submits a review of the current head, which clears its request. */
  submit(id: number, minute: number): void {
    this.reviews.push(review(id, this.head, minute));
    this.requested = [];
  }
}

/** The message a refused observation ends with. */
async function refusal(observation: Promise<unknown>): Promise<string> {
  try {
    await observation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the observation was expected to refuse');
}

function observe(
  github: FakeGitHub,
  book: Ledger,
  onSleep?: (elapsed: number) => void
): Promise<Observation> {
  let now = 0;
  return observeCopilotReview(REF, HEAD, {
    github: github.api,
    ledger: book,
    now: () => now,
    sleep: async ms => {
      now += ms;
      onSleep?.(now);
    },
    waitMs: 30 * MINUTE,
    pollMs: 30_000,
  });
}

describe('observing the Copilot review of the current head', () => {
  it('returns an existing review of the head without requesting another', async () => {
    const github = new FakeGitHub();
    github.reviews = [review(11, HEAD, 1)];
    github.comments.set(11, [
      { id: 501, path: 'src/a.ts', line: 3, html_url: `${PR_URL}#c501`, body: 'Off by one.' },
    ]);
    const observed = await observe(github, ledger());
    expect(observed.review.id).toBe('11');
    expect(observed.comments).toEqual([
      { id: '501', path: 'src/a.ts', line: 3, url: `${PR_URL}#c501`, body: 'Off by one.' },
    ]);
    expect(github.posts()).toBe(0);
  });

  it('ignores a stale review of an earlier head, requests once and waits for the new one', async () => {
    const github = new FakeGitHub();
    github.reviews = [review(10, OLD_HEAD, 1)];
    const book = ledger();
    const observed = await observe(github, book, elapsed => {
      if (elapsed === 5 * MINUTE) github.submit(12, 30);
    });
    expect(observed.review.id).toBe('12');
    expect(observed.review.head).toBe(HEAD);
    expect(github.posts()).toBe(1);
    expect(github.calls.find(call => call.method === 'POST')?.body).toEqual({
      reviewers: ['copilot-pull-request-reviewer[bot]'],
    });
    expect(book.request(HEAD)).toBe('accepted');
  });

  it('never takes a review while Copilot is still a requested reviewer', async () => {
    const github = new FakeGitHub();
    github.reviews = [review(11, HEAD, 1)];
    github.requested = [COPILOT_REQUESTED];
    const observed = await observe(github, ledger(), elapsed => {
      if (elapsed === 2 * MINUTE) github.submit(13, 40);
    });
    expect(observed.review.id).toBe('13');
    expect(github.posts()).toBe(0);
  });

  it('does not repeat a request after a restart, and times out visibly', async () => {
    const github = new FakeGitHub();
    github.requestListsCopilot = true;
    const dir = scratch();
    const first = observe(github, ledger(dir), () => {
      // Copilot drops the request without reviewing.
      github.requested = [];
    });
    expect(await refusal(first)).toMatch(/no Copilot review of a+ arrived within 30 minutes/);
    expect(github.posts()).toBe(1);

    const restarted = observe(github, ledger(dir, 'run-2'));
    expect(await refusal(restarted)).toMatch(/GitHub accepted the request and no longer lists Copilot as pending.*resume this run/);
    expect(github.posts()).toBe(1);
  });

  it('refuses when the head moves while it waits', async () => {
    const github = new FakeGitHub();
    github.requested = [COPILOT_REQUESTED];
    const moved = observe(github, ledger(), () => {
      github.head = 'c'.repeat(40);
    });
    expect(await refusal(moved)).toMatch(/moved from a+ to c+ while the gate waited/);
  });

  it('refuses a closed pull request', async () => {
    const github = new FakeGitHub();
    github.state = 'closed';
    expect(await refusal(observe(github, ledger()))).toMatch(/is closed, not open/);
  });

  it('stops on a failed GitHub read instead of retrying it', async () => {
    const github = new FakeGitHub();
    github.failOn = '/reviews';
    const failed = observe(github, ledger());
    expect(await refusal(failed)).toMatch(/rate limit exceeded/);
    expect(github.calls.filter(call => call.path.includes('/reviews'))).toHaveLength(1);
  });

  it('refuses a Copilot review missing the commit it reviewed', async () => {
    const github = new FakeGitHub();
    github.reviews = [{ ...review(11, HEAD, 1), commit_id: '' }];
    expect(await refusal(observe(github, ledger()))).toMatch(/without its id, commit, link or time/);
  });

  it('takes no other account as Copilot, whatever its login', async () => {
    const github = new FakeGitHub();
    github.reviews = [
      review(20, HEAD, 1, { id: 1, login: 'Copilot', type: 'User' }),
      review(21, HEAD, 2, { id: 175728472, login: 'someone', type: 'Bot' }),
    ];
    const observed = await observe(github, ledger(), elapsed => {
      if (elapsed === MINUTE) github.submit(22, 30);
    });
    expect(observed.review.id).toBe('22');
  });

  // Observed live: GitHub answered an accepted Copilot request with an empty
  // requested_reviewers list, and Copilot's review arrived minutes later.
  it('takes an accepted request whose receipt lists no reviewer, and waits for the review', async () => {
    const github = new FakeGitHub();
    github.requestListsCopilot = false;
    const book = ledger();
    const observed = await observe(github, book, elapsed => {
      if (elapsed === 4 * MINUTE) github.submit(14, 30);
    });
    expect(observed.review.id).toBe('14');
    expect(github.posts()).toBe(1);
    expect(book.request(HEAD)).toBe('accepted');
  });

  it('never requests twice after a lost receipt, and names the unknown outcome', async () => {
    const github = new FakeGitHub();
    github.requestListsCopilot = false;
    github.loseReceipt = true;
    const dir = scratch();
    expect(await refusal(observe(github, ledger(dir)))).toMatch(
      /failed or its receipt was lost, so whether GitHub applied it is unknown.*connection reset/
    );
    expect(ledger(dir).request(HEAD)).toBe('attempted');

    github.loseReceipt = false;
    const resumed = observe(github, ledger(dir, 'run-2'));
    expect(await refusal(resumed)).toMatch(/attempted but its receipt was never read, so whether GitHub applied it is unknown/);
    expect(github.posts()).toBe(1);
  });

  // Two runs observe one head and neither has requested a review yet.
  it('sends one request when another run claims it between this run\'s read and its claim', async () => {
    const github = new FakeGitHub();
    github.requestListsCopilot = false;
    const dir = scratch();
    const arrives = (elapsed: number): void => {
      if (elapsed === 4 * MINUTE && github.reviews.length === 0) github.submit(14, 30);
    };
    let other: Promise<Observation> | undefined;
    class ReadThenYield extends Ledger {
      override request(head: string): Receipt | undefined {
        const receipt = super.request(head);
        other ??= observe(github, ledger(dir, 'run-b'), arrives);
        return receipt;
      }
    }
    const mine = await observe(github, new ReadThenYield(ledger(dir, 'run-a').path, 'run-a'), arrives);
    expect(mine.review.id).toBe('14');
    expect((await other)?.review.id).toBe('14');
    expect(github.posts()).toBe(1);
    expect(
      ledger(dir).events().map(event => (event.event === 'requested' ? `${event.run} ${event.receipt}` : event.event))
    ).toEqual(['run-b attempted', 'run-b accepted', 'run-a attempted']);
  });

  it('sends one request when another run observes while this run\'s request is in flight', async () => {
    const github = new FakeGitHub();
    github.requestListsCopilot = false;
    const dir = scratch();
    let other: Promise<Observation> | undefined;
    github.onPost = (): void => {
      other ??= observe(github, ledger(dir, 'run-b'));
    };
    const mine = await observe(github, ledger(dir, 'run-a'), elapsed => {
      if (elapsed === 4 * MINUTE) github.submit(14, 30);
    });
    expect(mine.review.id).toBe('14');
    expect((await other)?.review.id).toBe('14');
    expect(github.posts()).toBe(1);
  });

  it('settles the request by log order when both claims land before either reads back', () => {
    const dir = scratch();
    // B's claim reaches the log after A read no request and before A writes its own.
    ledger(dir, 'run-b').append({ event: 'requested', head: HEAD, receipt: 'attempted' });
    expect(ledger(dir, 'run-a').claimRequest(HEAD)).toBe(false);
    expect(ledger(dir).request(HEAD)).toBe('attempted');
  });

  it('refuses a receipt for another head', async () => {
    const github = new FakeGitHub();
    const api: GitHub = request =>
      request.method === 'POST' ? { number: REF.number, head: { sha: OLD_HEAD }, requested_reviewers: [] } : github.api(request);
    const observed = observeCopilotReview(REF, HEAD, {
      github: api,
      ledger: ledger(),
      now: () => 0,
      sleep: () => Promise.resolve(),
      waitMs: 30 * MINUTE,
      pollMs: 30_000,
    });
    expect(await refusal(observed)).toMatch(new RegExp(`receipt for the review request names pull 7 at ${OLD_HEAD}`));
  });

  it('does not reuse a review it judged unavailable, and takes the next one', async () => {
    const github = new FakeGitHub();
    github.reviews = [review(30, HEAD, 1)];
    const book = ledger();
    book.append({ event: 'verdict', review: '30', head: HEAD, verdict: 'unavailable', findings: 0 });
    expect(await refusal(observe(github, book))).toMatch(/did not review the change.*request a Copilot review/);

    github.requested = [COPILOT_REQUESTED];
    const observed = await observe(github, book, elapsed => {
      if (elapsed === MINUTE) github.submit(31, 30);
    });
    expect(observed.review.id).toBe('31');
    expect(github.posts()).toBe(0);
  });
});

describe('the gh transport', () => {
  /** Runs `body` with `gh` answered by `answer`; every gh argv is returned in call order. */
  function withGh(answer: (argv: string[]) => string, body: () => void): string[][] {
    const calls: string[][] = [];
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((argv: string[]) => {
      calls.push(argv);
      return { exitCode: 0, stdout: Buffer.from(answer(argv)), stderr: Buffer.from('') };
    }) as unknown as typeof Bun.spawnSync);
    try {
      body();
    } finally {
      spawn.mockRestore();
    }
    return calls;
  }

  it('lists through gh pagination and posts its body from a file it removes', () => {
    let payload = '';
    let payloadPath = '';
    const calls = withGh(
      argv => {
        if (argv.includes('--slurp')) return '[[{"id":1}],[{"id":2}]]';
        payloadPath = argv[argv.indexOf('--input') + 1] ?? '';
        payload = readFileSync(payloadPath, 'utf8');
        return '{"number":7}';
      },
      () => {
        expect(ghApi({ path: 'repos/example/repo/pulls/7/reviews?per_page=100', list: true })).toEqual([
          [{ id: 1 }],
          [{ id: 2 }],
        ]);
        expect(
          ghApi({ method: 'POST', path: 'repos/example/repo/pulls/7/requested_reviewers', body: { reviewers: ['x'] } })
        ).toEqual({ number: 7 });
      }
    );
    expect(calls[0]).toEqual([
      'gh', 'api', '--hostname', 'github.com', 'repos/example/repo/pulls/7/reviews?per_page=100', '--paginate', '--slurp',
    ]);
    expect(calls[1]?.slice(0, 7)).toEqual([
      'gh', 'api', '--hostname', 'github.com', 'repos/example/repo/pulls/7/requested_reviewers', '--method', 'POST',
    ]);
    expect(JSON.parse(payload)).toEqual({ reviewers: ['x'] });
    expect(existsSync(payloadPath)).toBe(false);
  });

  it('refuses a listing that is not pages of rows', async () => {
    const github = new FakeGitHub();
    const api: GitHub = request => (request.list ? [{ id: 1 }] : github.api(request));
    const observed = observeCopilotReview(REF, HEAD, {
      github: api,
      ledger: ledger(),
      now: () => 0,
      sleep: () => Promise.resolve(),
      waitMs: 30 * MINUTE,
      pollMs: 30_000,
    });
    expect(await refusal(observed)).toMatch(/unexpected payload for .*\/reviews/);
  });
});

describe('the GitHub identity and host the gate acts on', () => {
  it('acts only as the configured login', () => {
    const github = new FakeGitHub();
    expect(() => { assertIdentity(github.api, 'shami13'); }).not.toThrow();
    expect(() => { assertIdentity(github.api, 'SHAMI13'); }).not.toThrow();
    github.login = 'someone-else';
    expect(() => { assertIdentity(github.api, 'shami13'); }).toThrow(/belongs to someone-else, not shami13/);
  });

  it('refuses a host whose Copilot account it cannot verify', () => {
    expect(() => { assertCopilotHost({ ...REF, repo: { host: 'ghe.example.com', path: 'o/r' } }); }).toThrow(
      /github.com only/
    );
  });
});

describe('the policy that turns the gate on', () => {
  function withEnv<T>(env: Record<string, string | undefined>, body: () => T): T {
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    for (const [key, value] of Object.entries(env)) if (value === undefined) Reflect.deleteProperty(process.env, key);
    try {
      return body();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  }

  it('is off unless a project asks for it', () => {
    expect(withEnv({ ARCHON_SDLC_EXTERNAL_REVIEW: undefined }, externalReviewPolicy)).toEqual({ mode: 'none' });
    expect(withEnv({ ARCHON_SDLC_EXTERNAL_REVIEW: 'none' }, externalReviewPolicy)).toEqual({ mode: 'none' });
  });

  it('needs the login it may act as', () => {
    expect(
      withEnv({ ARCHON_SDLC_EXTERNAL_REVIEW: 'copilot', ARCHON_SDLC_GITHUB_LOGIN: 'shami13' }, externalReviewPolicy)
    ).toEqual({ mode: 'copilot', login: 'shami13' });
    expect(() =>
      withEnv({ ARCHON_SDLC_EXTERNAL_REVIEW: 'copilot', ARCHON_SDLC_GITHUB_LOGIN: undefined }, externalReviewPolicy)
    ).toThrow(/needs ARCHON_SDLC_GITHUB_LOGIN/);
  });

  it('runs Codex without a GitHub login, since it only reads the pull request', () => {
    expect(
      withEnv({ ARCHON_SDLC_EXTERNAL_REVIEW: 'codex', ARCHON_SDLC_GITHUB_LOGIN: undefined }, externalReviewPolicy)
    ).toEqual({ mode: 'codex' });
  });

  it('refuses a value it does not know rather than turning the gate off', () => {
    expect(() => withEnv({ ARCHON_SDLC_EXTERNAL_REVIEW: 'Copilot' }, externalReviewPolicy)).toThrow(
      /must be one of "none", "copilot", "codex" \(the first is the default\), not "Copilot"/
    );
  });
});

describe('routing a review', () => {
  const inline = findingsOf(
    [{ id: '501', path: 'src/a.ts', line: 3, url: `${PR_URL}#c501`, body: 'Off by one.' }],
    ['The overview says the retry path is untested.']
  );

  it('keeps every inline comment and adds the overview findings', () => {
    expect(inline.map(finding => [finding.id, finding.source])).toEqual([
      ['copilot-c501', 'inline'],
      ['copilot-o1', 'overview'],
    ]);
  });

  it('passes a review with no findings, and never one Copilot did not perform', () => {
    const book = ledger();
    expect(decide({ review: '1', outcome: 'reviewed', findings: [], allowCorrection: true, ledger: book })).toBe('clean');
    expect(decide({ review: '1', outcome: 'unavailable', findings: [], allowCorrection: true, ledger: book })).toBe(
      'unavailable'
    );
  });

  it('corrects confirmed findings and passes an unchanged head only once its declines were verified', () => {
    const book = ledger();
    const input = { review: '1', outcome: 'reviewed' as const, findings: inline, allowCorrection: true, ledger: book };
    expect(decide(input)).toBe('correct');
    expect(book.recordVerdict({ review: '1', head: HEAD, verdict: decide(input), findings: 2 })).toEqual({
      verdict: 'correct',
      corrections: 1,
    });
    // A rerun of the same cycle after a restart is the same correction.
    expect(book.recordVerdict({ review: '1', head: HEAD, verdict: decide(input), findings: 2 })).toEqual({
      verdict: 'correct',
      corrections: 1,
    });
    book.append({ event: 'verified', review: '1', head: HEAD });
    expect(decide(input)).toBe('adjudicated');
  });

  const claim = (book: Ledger, review: string): { verdict: string; corrections: number } => {
    const verdict = decide({ review, outcome: 'reviewed', findings: inline, allowCorrection: true, ledger: book });
    return book.recordVerdict({ review, head: `h-${review}`, verdict, findings: 2 });
  };

  it('allows five corrections per pull request, counted from the persisted ledger', () => {
    const dir = scratch();
    const first = ledger(dir, 'run-1');
    for (let cycle = 1; cycle <= MAX_CORRECTIONS; cycle++) {
      expect(claim(first, String(cycle))).toEqual({ verdict: 'correct', corrections: cycle });
      first.append({ event: 'verified', review: String(cycle), head: `h-${String(cycle)}` });
    }
    // A restarted or later run on the same pull request reads the same count.
    const restarted = ledger(dir, 'run-2');
    expect(restarted.correctionsUsed()).toBe(5);
    expect(claim(restarted, '6')).toEqual({ verdict: 'exhausted', corrections: 5 });
    expect(
      decide({ review: '6', outcome: 'reviewed', findings: [], allowCorrection: true, ledger: restarted })
    ).toBe('clean');
  });

  function fourUsed(): string {
    const dir = scratch();
    const book = ledger(dir, 'run-0');
    for (let cycle = 1; cycle <= MAX_CORRECTIONS - 1; cycle++) {
      book.append({ event: 'verdict', review: `r${String(cycle)}`, head: `h${String(cycle)}`, verdict: 'correct', findings: 1 });
      book.append({ event: 'verified', review: `r${String(cycle)}`, head: `h${String(cycle)}` });
    }
    return dir;
  }

  const correct = (review: string, head = `h-${review}`) =>
    ({ review, head, verdict: 'correct', findings: 2 }) as const;

  // Two runs on one pull request each decide to correct before either writes.
  it('lets exactly one of two racing runs spend the last correction', () => {
    const dir = fourUsed();
    const a = ledger(dir, 'run-a');
    const b = ledger(dir, 'run-b');
    const input = (review: string, book: Ledger) =>
      ({ review, outcome: 'reviewed', findings: inline, allowCorrection: true, ledger: book }) as const;
    expect(decide(input('rA', a))).toBe('correct');
    expect(decide(input('rB', b))).toBe('correct');
    expect(a.recordVerdict(correct('rA'))).toEqual({ verdict: 'correct', corrections: 5 });
    expect(b.recordVerdict(correct('rB'))).toEqual({ verdict: 'exhausted', corrections: 5 });
    expect(ledger(dir, 'run-c').correctionsUsed()).toBe(5);
    expect(claim(ledger(dir, 'run-b'), 'rB').verdict).toBe('exhausted');
  });

  it('settles the race by log order when both claims land before either reads back', () => {
    const dir = fourUsed();
    const a = ledger(dir, 'run-a');
    const b = ledger(dir, 'run-b');
    expect(decide({ review: 'rA', outcome: 'reviewed', findings: inline, allowCorrection: true, ledger: a })).toBe(
      'correct'
    );
    // B's claim reaches the log after A decided and before A writes its own.
    b.append({ event: 'verdict', ...correct('rB') });
    expect(a.recordVerdict(correct('rA'))).toEqual({ verdict: 'exhausted', corrections: 5 });
    expect(b.recordVerdict(correct('rB')).verdict).toBe('correct');
    expect(b.correctionsUsed()).toBe(5);
  });

  // Two runs on one head observe the same Copilot review, so both claim its cycle.
  it('lets one of two runs correct the same review at four used cycles, and the other refuses', () => {
    const dir = fourUsed();
    const a = ledger(dir, 'run-a');
    const b = ledger(dir, 'run-b');
    expect(claim(a, 'r5')).toEqual({ verdict: 'correct', corrections: 5 });
    expect(claim(b, 'r5')).toEqual({ verdict: 'claimed', corrections: 5 });
    expect(b.correctionHolder('r5')).toBe('run-a');
    expect(ledger(dir, 'run-c').correctionsUsed()).toBe(5);
    // A resume of the holder keeps its cycle; no other run takes it, nor a sixth.
    expect(claim(ledger(dir, 'run-a'), 'r5')).toEqual({ verdict: 'correct', corrections: 5 });
    expect(claim(ledger(dir, 'run-b'), 'r5').verdict).toBe('claimed');
    expect(claim(ledger(dir, 'run-b'), 'r6').verdict).toBe('exhausted');
    expect(ledger(dir, 'run-c').correctionsUsed()).toBe(5);
  });

  it('settles the same review by log order when both claims land before either reads back', () => {
    const dir = fourUsed();
    const a = ledger(dir, 'run-a');
    const b = ledger(dir, 'run-b');
    // B's claim on r5 reaches the log after A decided and before A writes its own.
    b.append({ event: 'verdict', ...correct('r5') });
    expect(a.recordVerdict(correct('r5')).verdict).toBe('claimed');
    expect(b.recordVerdict(correct('r5')).verdict).toBe('correct');
    expect(a.correctionsUsed()).toBe(5);
  });

  it('never reopens a verified correction for a run that lost its review', () => {
    const dir = scratch();
    const a = ledger(dir, 'run-a');
    expect(claim(a, 'r1').verdict).toBe('correct');
    a.append({ event: 'verified', review: 'r1', head: 'h-r1' });
    // B decided to correct r1 before A's verification and writes its claim after it.
    expect(ledger(dir, 'run-b').recordVerdict(correct('r1')).verdict).toBe('claimed');
    expect(a.unverifiedCorrection()).toBeUndefined();
    a.append({ event: 'verdict', review: 'r2', head: 'h-r2', verdict: 'clean', findings: 0 });
    expect(a.ready('h-r2')).toBe(true);
  });

  it('gives a losing claim cut short by a crash no cycle on resume', () => {
    const dir = fourUsed();
    const book = ledger(dir);
    expect(claim(book, 'rA').verdict).toBe('correct');
    book.append({ event: 'verdict', ...correct('rB') });
    expect(book.correctionsUsed()).toBe(5);
    expect(book.correctionHolder('rB')).toBeUndefined();
    expect(claim(ledger(dir, 'run-2'), 'rB').verdict).toBe('exhausted');
  });

  it('passes nothing while a correction waits for its internal review', () => {
    const book = ledger();
    expect(claim(book, 'r1').verdict).toBe('correct');
    // The recheck refused, the run resumed at a fresh review of the corrected head.
    expect(book.unverifiedCorrection()).toBe('r1');
    const fresh = { review: 'r2', outcome: 'reviewed' as const, findings: [], allowCorrection: true, ledger: book };
    expect(decide(fresh)).toBe('correct');
    expect(decide({ ...fresh, allowCorrection: false })).toBe('blocked');
    book.append({ event: 'verdict', review: 'r2', head: 'h-r2', verdict: 'clean', findings: 0 });
    expect(book.ready('h-r2')).toBe(false);

    expect(claim(book, 'r2')).toEqual({ verdict: 'correct', corrections: 2 });
    book.append({ event: 'verified', review: 'r2', head: 'h-r2' });
    expect(book.unverifiedCorrection()).toBeUndefined();
    book.append({ event: 'verdict', review: 'r3', head: 'h-r3', verdict: 'clean', findings: 0 });
    expect(book.ready('h-r3')).toBe(true);
  });

  it('blocks findings on a verification-only review', () => {
    expect(
      decide({ review: '1', outcome: 'reviewed', findings: inline, allowCorrection: false, ledger: ledger() })
    ).toBe('blocked');
  });
});

describe('the ledger', () => {
  it('calls a head ready only while its last verdict passes', () => {
    const book = ledger();
    expect(book.ready(HEAD)).toBe(false);
    book.append({ event: 'verdict', review: '1', head: HEAD, verdict: 'clean', findings: 0 });
    expect(book.ready(HEAD)).toBe(true);
    expect(book.ready(OLD_HEAD)).toBe(false);
    book.append({ event: 'verdict', review: '2', head: HEAD, verdict: 'unavailable', findings: 0 });
    expect(book.ready(HEAD)).toBe(false);
  });

  it('records nothing for an unnamed run, since claims are settled by run', () => {
    expect(() => {
      ledger(scratch(), '').append({ event: 'requested', head: HEAD, receipt: 'attempted' });
    }).toThrow(/WORKFLOW_ID must be set/);
  });

  it('refuses an unreadable line rather than guessing past it', () => {
    const book = ledger();
    mkdirSync(dirname(book.path), { recursive: true });
    writeFileSync(book.path, '{"event":"requested","head":"x","receipt":"accepted","at":"t","run":"r"}\nnot json\n');
    expect(() => book.correctionsUsed()).toThrow(/unreadable line 2/);
  });
});

describe('the node scripts', () => {
  const feedback = (review: string, head: string, comments: object[] = []): string =>
    JSON.stringify({ pr: REF, head, review: { id: review, url: `${PR_URL}#review-${review}`, state: 'COMMENTED', submittedAt: 't', body: 'x' }, comments });

  function route(state: string, inputs: Record<string, string>, comments: object[] = []): ScriptRun {
    return runPackScript('deliver/scripts/external-review-route', {
      inputs: {
        INPUTS_PR: JSON.stringify(REF),
        INPUTS_REVIEW: '9',
        INPUTS_HEAD: HEAD,
        INPUTS_OUTCOME: 'reviewed',
        INPUTS_REASON: 'Copilot recommends changes.',
        INPUTS_OVERVIEW: '[]',
        INPUTS_CORRECTIONS: 'allowed',
        STATE_DIR: state,
        WORKFLOW_ID: 'run-1',
        ...inputs,
      },
      artifacts: { 'external-review/feedback.json': feedback('9', HEAD, comments) },
    });
  }

  it('routes a clean review and records the verdict', () => {
    const state = scratch();
    const run = route(state, {});
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ action: 'clean', corrections: 0 });
    expect(ledger(state).ready(HEAD)).toBe(true);
    expect(readFileSync(join(run.artifacts, 'external-review/report.md'), 'utf8')).toContain('Status: clean');
  });

  it('surfaces an unavailable review as a failure with its durable report', () => {
    const state = scratch();
    const run = route(state, { INPUTS_OUTCOME: 'unavailable', INPUTS_REASON: 'Copilot had insufficient quota.' });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Copilot did not review the change');
    const report = readFileSync(join(run.artifacts, 'external-review/report.md'), 'utf8');
    expect(report).toContain(`Pull request: https://github.com/${REF.repo.path}/pull/7`);
    expect(report).toContain('Status: unavailable');
    expect(report).toContain('Corrections used: 0 of 5');
  });

  it('refuses an exhausted pull request with its remaining findings in the report', () => {
    const state = scratch();
    const book = ledger(state);
    for (let cycle = 1; cycle <= MAX_CORRECTIONS; cycle++) {
      book.append({ event: 'verdict', review: `r${String(cycle)}`, head: `h${String(cycle)}`, verdict: 'correct', findings: 1 });
    }
    const run = route(state, {}, [{ id: '77', path: 'src/b.ts', line: 9, url: `${PR_URL}#c77`, body: 'Still racy.' }]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('used every correction cycle');
    const report = readFileSync(join(run.artifacts, 'external-review/report.md'), 'utf8');
    expect(report).toContain('copilot-c77 (inline, src/b.ts:9): Still racy.');
    expect(report).toContain('Corrections used: 5 of 5');
    expect(JSON.parse(readFileSync(join(run.artifacts, 'external-review/findings.json'), 'utf8')).findings).toHaveLength(1);
  });

  it('reports a started correction cycle before the stages that can fail after it', () => {
    const state = scratch();
    const run = route(state, {}, [{ id: '78', path: 'src/c.ts', line: 2, url: `${PR_URL}#c78`, body: 'Unchecked input.' }]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ action: 'correct', corrections: 1 });
    const report = readFileSync(join(run.artifacts, 'external-review/report.md'), 'utf8');
    expect(report).toContain('Status: correct');
    expect(report).toContain('This run holds a correction cycle, 1 of 5 now in use, and runs it next');
    expect(report).toContain('If the run stopped after this report, one of those stages failed');
    expect(report).toContain('Unverified correction: review 9');
  });

  it('runs another cycle on a clean review while an earlier correction is unverified', () => {
    const state = scratch();
    ledger(state).append({ event: 'verdict', review: '8', head: OLD_HEAD, verdict: 'correct', findings: 1 });
    const run = route(state, {});
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ action: 'correct', corrections: 2 });
    const findings = JSON.parse(readFileSync(join(run.artifacts, 'external-review/findings.json'), 'utf8'));
    expect(findings.unverified_correction).toBe('8');
    expect(readFileSync(join(run.artifacts, 'external-review/report.md'), 'utf8')).toContain(
      'The correction for Copilot review 8 has not passed the internal review'
    );
  });

  // Two deliveries on one head observed Copilot review 9 with four cycles used.
  it('lets only the run holding a review correct it; the other refuses before any fix', () => {
    const state = scratch();
    const book = ledger(state, 'run-0');
    for (let cycle = 1; cycle <= MAX_CORRECTIONS - 1; cycle++) {
      book.append({ event: 'verdict', review: `r${String(cycle)}`, head: `h${String(cycle)}`, verdict: 'correct', findings: 1 });
      book.append({ event: 'verified', review: `r${String(cycle)}`, head: `h${String(cycle)}` });
    }
    const comments = [{ id: '79', path: 'src/d.ts', line: 4, url: `${PR_URL}#c79`, body: 'Leaks a handle.' }];
    const holder = route(state, { WORKFLOW_ID: 'run-a' }, comments);
    expect(holder.code).toBe(0);
    expect(JSON.parse(holder.stdout)).toEqual({ action: 'correct', corrections: 5 });

    const loser = route(state, { WORKFLOW_ID: 'run-b' }, comments);
    expect(loser.code).not.toBe(0);
    expect(loser.stdout).toBe('');
    expect(loser.stderr).toContain('run run-a already holds the correction cycle for this review');
    expect(readFileSync(join(loser.artifacts, 'external-review/report.md'), 'utf8')).toContain('Status: claimed');

    const resumed = route(state, { WORKFLOW_ID: 'run-a' }, comments);
    expect(JSON.parse(resumed.stdout)).toEqual({ action: 'correct', corrections: 5 });
    expect(ledger(state).correctionsUsed()).toBe(5);
  });

  it('refuses feedback that describes another review or head', () => {
    const run = route(scratch(), { INPUTS_HEAD: OLD_HEAD });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('does not describe review 9');
  });

  it('records a verified correction only when the internal review found nothing open', () => {
    const state = scratch();
    const verified = (action: string): ScriptRun =>
      runPackScript('deliver/scripts/external-review-verified', {
        inputs: {
          INPUTS_PR: JSON.stringify(REF),
          INPUTS_REVIEW: '9',
          INPUTS_HEAD: HEAD,
          INPUTS_REVIEW_ACTION: action,
          STATE_DIR: state,
          WORKFLOW_ID: 'run-1',
        },
      });
    const refused = verified('correct');
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('returned "correct"');
    expect(refused.stderr).toContain('does not flip the pull request ready');
    expect(refused.stderr).not.toContain('draft');
    expect(ledger(state).verified('9')).toBe(false);
    expect(readFileSync(join(refused.artifacts, 'external-review/report.md'), 'utf8')).toContain(
      'Status: correction not verified'
    );

    expect(verified('none').code).toBe(0);
    expect(ledger(state).verified('9')).toBe(true);
  });
});

describe('the observation report', () => {
  it('says triage comes next, so a failed triage leaves a truthful report', () => {
    const artifacts = scratch();
    const book = ledger();
    writeObservation(artifacts, book, REF, {
      review: { id: '15', head: HEAD, url: `${PR_URL}#review-15`, state: 'COMMENTED', submittedAt: 't', body: 'x' },
      comments: [],
    });
    const report = readFileSync(join(artifacts, 'external-review/report.md'), 'utf8');
    expect(report).toContain('Status: observed');
    expect(report).toContain(`Head: ${HEAD}`);
    expect(report).toContain('if the run stopped after this report, that triage failed');
    expect(JSON.parse(readFileSync(join(artifacts, 'external-review/feedback.json'), 'utf8')).review.id).toBe('15');
  });

  it('keeps the refusal reason when the report cannot be written', () => {
    const blocked = join(scratch(), 'artifacts');
    writeFileSync(blocked, 'a file where the artifact directory should be');
    const run = runPackScript('deliver/scripts/external-review-verified', {
      inputs: {
        INPUTS_PR: JSON.stringify(REF),
        INPUTS_REVIEW: '9',
        INPUTS_HEAD: HEAD,
        INPUTS_REVIEW_ACTION: 'replan',
        STATE_DIR: scratch(),
        WORKFLOW_ID: 'run-1',
        ARTIFACTS_DIR: blocked,
      },
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('returned "replan"');
    expect(run.stderr).toContain('the external review report could not be written');
  });
});

describe('the merge paths under the external review gate', () => {
  const URL = `https://github.com/${REF.repo.path}/pull/7`;

  function withPolicy<T>(state: string, body: () => T, mode = 'copilot'): T {
    const keys = ['ARCHON_SDLC_EXTERNAL_REVIEW', 'ARCHON_SDLC_GITHUB_LOGIN', 'STATE_DIR'] as const;
    const saved = keys.map(key => process.env[key]);
    Object.assign(process.env, { ARCHON_SDLC_EXTERNAL_REVIEW: mode, ARCHON_SDLC_GITHUB_LOGIN: 'shami13', STATE_DIR: state });
    try {
      return body();
    } finally {
      keys.forEach((key, index) => {
        const value = saved[index];
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      });
    }
  }

  it('holds nothing when the gate is off', () => {
    expect(withPolicy(scratch(), () => externalReviewHold(URL, HEAD), 'none')).toBeUndefined();
  });

  it('holds a head no passing review covers, and releases a ready one', () => {
    const state = scratch();
    expect(withPolicy(state, () => externalReviewHold(URL, HEAD))).toMatch(/no passing Copilot review .* deliver it through archon-deliver/);
    ledger(state).append({ event: 'verdict', review: '1', head: HEAD, verdict: 'clean', findings: 0 });
    expect(withPolicy(state, () => externalReviewHold(URL, HEAD))).toBeUndefined();
    expect(withPolicy(state, () => externalReviewHold(URL, OLD_HEAD))).toMatch(/no passing Copilot review/);
  });

  it('refuses the loop merge gate on a head no passing review covers', () => {
    const state = scratch();
    const run = runPackScript('loop/scripts/land', {
      gh: { pr: { headRefOid: HEAD } },
      inputs: {
        INPUTS_PR: URL,
        INPUTS_SHA: HEAD,
        INPUTS_ROUTE: 'simple',
        INPUTS_REPORT: JSON.stringify({ pr: URL, head: HEAD, overall: 'PASS', lines: [] }),
        ARCHON_SDLC_EXTERNAL_REVIEW: 'copilot',
        ARCHON_SDLC_GITHUB_LOGIN: 'shami13',
        STATE_DIR: state,
      },
    });
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as { outcome: string; reason: string };
    expect(result.outcome).toBe('refused');
    expect(result.reason).toContain(`no passing Copilot review of ${URL} at ${HEAD}; deliver it through archon-deliver`);
    expect(run.gh.some(call => call.startsWith('pr merge'))).toBe(false);
  });

  // A PR branch whose base moved after the review by a file the change does not touch.
  function landCheckout(baseMoves: boolean): { work: string; origin: string; sha: string } {
    const root = scratch();
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    git(root, 'init', '--quiet', '--bare', origin);
    git(root, 'init', '--quiet', '-b', 'dev', work);
    git(work, 'remote', 'add', 'origin', origin);
    const commit = (file: string): void => {
      writeFileSync(join(work, file), `${file}\n`);
      git(work, 'add', file);
      git(work, 'commit', '--quiet', '-m', file);
    };
    commit('base.txt');
    git(work, 'push', '--quiet', 'origin', 'dev');
    git(work, 'checkout', '--quiet', '-b', 'feature');
    commit('feature.txt');
    const sha = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '--quiet', 'origin', 'feature', 'feature:refs/pull/42/head');
    if (baseMoves) {
      git(work, 'checkout', '--quiet', 'dev');
      commit('other.txt');
      git(work, 'push', '--quiet', 'origin', 'dev');
      git(work, 'checkout', '--quiet', 'feature');
    }
    return { work, origin, sha };
  }

  function land(checkout: { work: string; sha: string }, state: string, mode: string): ScriptRun {
    const url = `https://github.com/${REF.repo.path}/pull/42`;
    return runPackScript('loop/scripts/land', {
      cwd: checkout.work,
      gh: { pr: { headRefOid: checkout.sha, headRefName: 'feature', baseRefName: 'dev' } },
      inputs: {
        INPUTS_PR: url,
        INPUTS_SHA: checkout.sha,
        INPUTS_ROUTE: 'simple',
        INPUTS_FILES: 'feature.txt',
        INPUTS_REPORT: JSON.stringify({ pr: url, head: checkout.sha, overall: 'PASS', lines: [] }),
        ARCHON_SDLC_EXTERNAL_REVIEW: mode,
        ARCHON_SDLC_GITHUB_LOGIN: 'shami13',
        STATE_DIR: state,
        ...GIT_ISOLATION,
      },
    });
  }

  function passed(state: string, head: string): void {
    Ledger.forPull(state, { ...REF, number: 42 }, 'run-1').append({
      event: 'verdict',
      review: '1',
      head,
      verdict: 'clean',
      findings: 0,
    });
  }

  it('merges a reviewed head whose base has not moved', () => {
    const checkout = landCheckout(false);
    const state = scratch();
    passed(state, checkout.sha);
    const run = land(checkout, state, 'copilot');
    expect(run.gh).toContain(
      `pr merge https://github.com/${REF.repo.path}/pull/42 --squash --match-head-commit ${checkout.sha}`
    );
  });

  it('refuses a moved base without pushing a merge no Copilot review covers', () => {
    const checkout = landCheckout(true);
    const state = scratch();
    passed(state, checkout.sha);
    const run = land(checkout, state, 'copilot');
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as { outcome: string; reason: string };
    expect(result.outcome).toBe('refused');
    expect(result.reason).toContain('dev has moved past the reviewed head');
    expect(result.reason).toContain('through archon-deliver');
    expect(run.gh.some(call => call.startsWith('pr merge'))).toBe(false);
    expect(git(checkout.origin, 'rev-parse', 'refs/heads/feature')).toBe(checkout.sha);
  });

  it('still merges a moved base in first when the gate is off', () => {
    const checkout = landCheckout(true);
    const run = land(checkout, scratch(), 'none');
    const pushed = git(checkout.origin, 'rev-parse', 'refs/heads/feature');
    expect(pushed).not.toBe(checkout.sha);
    expect(git(checkout.origin, 'rev-parse', `${pushed}^1`)).toBe(checkout.sha);
    expect(run.gh.some(call => call.startsWith(`pr merge https://github.com/${REF.repo.path}/pull/42 --squash --match-head-commit ${pushed}`))).toBe(true);
  });

  it('holds what it cannot confirm', () => {
    expect(withPolicy(scratch(), () => externalReviewHold('https://ghe.example.com/o/r/pull/1', HEAD))).toMatch(
      /could not confirm .*github.com only/
    );
    expect(withPolicy(scratch(), () => externalReviewHold('not a url', HEAD))).toMatch(/is not a pull request URL/);
  });
});

describe('the YAML vocabulary the scripts share', () => {
  interface Node {
    id: string;
    output_format?: { properties: Record<string, { enum?: string[] }> };
    loop_group?: { nodes: Node[] };
  }
  const deliver = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, '../../workflows/sdlc/deliver/archon-deliver.yaml'), 'utf8')
  ) as { nodes: Node[] };
  const body = deliver.nodes.find(node => node.id === 'external-review')?.loop_group?.nodes ?? [];
  const property = (nodes: readonly Node[], id: string, name: string): string[] | undefined =>
    nodes.find(node => node.id === id)?.output_format?.properties[name]?.enum;

  it('declares the policy modes, route actions and triage outcomes the scripts accept', () => {
    expect(property(deliver.nodes, 'external-review-policy', 'mode')).toEqual([...EXTERNAL_REVIEW_MODES]);
    expect(property(body, 'external-route', 'action')).toEqual([...ROUTE_ACTIONS]);
    expect(property(body, 'external-triage', 'outcome')).toEqual([...TRIAGE_OUTCOMES]);
  });
});

describe('the ready flip under the external review gate', () => {
  it('flips when the head is the one the review covered', () => {
    const run = runDeliverScript('flip-ready', { inputs: { INPUTS_EXPECTED_HEAD: 'deadbeef' }, gh: { rollup: 0 } });
    expect(run.code).toBe(0);
    expect(run.gh.some(call => call.startsWith('pr ready'))).toBe(true);
  });

  it('refuses before the flip when the head moved after the review', () => {
    const run = runDeliverScript('flip-ready', { inputs: { INPUTS_EXPECTED_HEAD: HEAD }, gh: { rollup: 0 } });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`not ${HEAD}, the head the external review covered`);
    expect(run.gh.some(call => call.startsWith('pr ready'))).toBe(false);
  });
});
