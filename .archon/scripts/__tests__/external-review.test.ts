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
  decide,
  externalReviewPolicy,
  findingsOf,
  ghApi,
  observeCopilotReview,
  type GitHub,
  type GitHubRequest,
  type Observation,
} from '../../workflows/sdlc/.shared/external-review';
import type { QualifiedPr } from '../../workflows/sdlc/.shared/forge';
import { PR_URL, runDeliverScript, runPackScript, type ScriptRun } from './deliver-checks-harness';

const trackTempRoot = trackTempRoots();
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
      return { state: this.state, head: { sha: this.head }, requested_reviewers: this.requested };
    }
    if (path === `${base}/requested_reviewers` && request.method === 'POST') {
      if (this.requestListsCopilot) this.requested = [COPILOT_REQUESTED];
      return { requested_reviewers: this.requested };
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
    expect(book.requested(HEAD)).toBe(true);
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
    expect(await refusal(restarted)).toMatch(/Copilot is not a requested reviewer.*resume this run/);
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

  it('refuses when GitHub accepts the request but does not list Copilot', async () => {
    const github = new FakeGitHub();
    github.requestListsCopilot = false;
    expect(await refusal(observe(github, ledger()))).toMatch(/does not list Copilot as a requested reviewer/);
  });

  it('does not reuse a review it judged unavailable, and takes the next one', async () => {
    const github = new FakeGitHub();
    github.reviews = [review(30, HEAD, 1)];
    const book = ledger();
    book.append({ event: 'verdict', review: '30', head: HEAD, verdict: 'unavailable', findings: 0, corrections: 0 });
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

  it('refuses a value it does not know rather than turning the gate off', () => {
    expect(() => withEnv({ ARCHON_SDLC_EXTERNAL_REVIEW: 'Copilot' }, externalReviewPolicy)).toThrow(
      /must be "none" \(the default\) or "copilot"/
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
    expect(decide({ review: '1', outcome: 'reviewed', findings: [], allowCorrection: true, ledger: book }).verdict).toBe(
      'clean'
    );
    expect(
      decide({ review: '1', outcome: 'unavailable', findings: [], allowCorrection: true, ledger: book }).verdict
    ).toBe('unavailable');
  });

  it('corrects confirmed findings and passes an unchanged head only once its declines were verified', () => {
    const book = ledger();
    const input = { review: '1', outcome: 'reviewed' as const, findings: inline, allowCorrection: true, ledger: book };
    expect(decide(input)).toEqual({ verdict: 'correct', corrections: 1 });
    book.append({ event: 'verdict', review: '1', head: HEAD, verdict: 'correct', findings: 2, corrections: 1 });
    // A rerun of the same cycle after a restart is the same correction.
    expect(decide(input)).toEqual({ verdict: 'correct', corrections: 1 });
    book.append({ event: 'verified', review: '1', head: HEAD });
    expect(decide(input)).toEqual({ verdict: 'adjudicated', corrections: 1 });
  });

  it('allows five corrections per pull request, counted from the persisted ledger', () => {
    const dir = scratch();
    const first = ledger(dir, 'run-1');
    for (let cycle = 1; cycle <= MAX_CORRECTIONS; cycle++) {
      const verdict = decide({
        review: String(cycle),
        outcome: 'reviewed',
        findings: inline,
        allowCorrection: true,
        ledger: first,
      });
      expect(verdict).toEqual({ verdict: 'correct', corrections: cycle });
      first.append({ event: 'verdict', review: String(cycle), head: `h${String(cycle)}`, verdict: 'correct', findings: 2, corrections: cycle });
    }
    // A restarted or later run on the same pull request reads the same count.
    const restarted = ledger(dir, 'run-2');
    expect(restarted.correctionsUsed()).toBe(5);
    expect(
      decide({ review: '6', outcome: 'reviewed', findings: inline, allowCorrection: true, ledger: restarted })
    ).toEqual({ verdict: 'exhausted', corrections: 5 });
    expect(
      decide({ review: '6', outcome: 'reviewed', findings: [], allowCorrection: true, ledger: restarted }).verdict
    ).toBe('clean');
  });

  it('blocks findings on a verification-only review', () => {
    expect(
      decide({ review: '1', outcome: 'reviewed', findings: inline, allowCorrection: false, ledger: ledger() }).verdict
    ).toBe('blocked');
  });
});

describe('the ledger', () => {
  it('calls a head ready only while its last verdict passes', () => {
    const book = ledger();
    expect(book.ready(HEAD)).toBe(false);
    book.append({ event: 'verdict', review: '1', head: HEAD, verdict: 'clean', findings: 0, corrections: 0 });
    expect(book.ready(HEAD)).toBe(true);
    expect(book.ready(OLD_HEAD)).toBe(false);
    book.append({ event: 'verdict', review: '2', head: HEAD, verdict: 'unavailable', findings: 0, corrections: 0 });
    expect(book.ready(HEAD)).toBe(false);
  });

  it('refuses an unreadable line rather than guessing past it', () => {
    const book = ledger();
    mkdirSync(dirname(book.path), { recursive: true });
    writeFileSync(book.path, '{"event":"requested","head":"x","at":"t","run":"r"}\nnot json\n');
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
      book.append({ event: 'verdict', review: `r${String(cycle)}`, head: `h${String(cycle)}`, verdict: 'correct', findings: 1, corrections: cycle });
    }
    const run = route(state, {}, [{ id: '77', path: 'src/b.ts', line: 9, url: `${PR_URL}#c77`, body: 'Still racy.' }]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('used every correction cycle');
    const report = readFileSync(join(run.artifacts, 'external-review/report.md'), 'utf8');
    expect(report).toContain('copilot-c77 (inline, src/b.ts:9): Still racy.');
    expect(report).toContain('Corrections used: 5 of 5');
    expect(JSON.parse(readFileSync(join(run.artifacts, 'external-review/findings.json'), 'utf8')).findings).toHaveLength(1);
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
    expect(ledger(state).verified('9')).toBe(false);
    expect(existsSync(join(refused.artifacts, 'external-review/report.md'))).toBe(true);

    expect(verified('none').code).toBe(0);
    expect(ledger(state).verified('9')).toBe(true);
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
