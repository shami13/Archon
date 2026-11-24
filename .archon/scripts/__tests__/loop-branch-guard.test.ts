/**
 * One branch, one worktree: a lap never takes a branch another run's worktree holds with work
 * no remote has, and a run that leaves such work keeps its claim. The 2026-11-22 sequence: a
 * failed run committed on the pull request's branch and never pushed; the next lap continuing
 * that pull request forced a second worktree onto the branch and moved it under the first.
 * Also the 2026-11-23 one: a continue move that committed nothing failed pre-review because
 * its checkout stayed on its own branch.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';
import { CLAIM_PREFIX } from '../../workflows/sdlc/.shared/claims';
import { pushesCommit } from '../../workflows/sdlc/.shared/builder-report';
import { holders } from '../../workflows/sdlc/.shared/held-branch';
import { takeBranch } from '../../workflows/sdlc/loop/scripts/checkout';
import { keptClaim, leftBehind } from '../../workflows/sdlc/loop/scripts/release';

const trackTempRoot = trackTempRoots();
const PRE_REVIEW = join(import.meta.dir, '../../workflows/sdlc/loop/scripts/pre-review.ts');

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd: string, message: string): string {
  writeFileSync(join(cwd, 'file.txt'), message);
  git(cwd, 'add', 'file.txt');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', '--short', 'HEAD');
}

/**
 * origin with `main` and the pull request's branch `feat`; the clone's worktree `earlier` (a run
 * that failed) has `feat` checked out, and `lap` (the new run) sits on its own branch.
 */
function repository(): { root: string; earlier: string; lap: string } {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-branch-guard-')));
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'clone', '-q', join(root, 'origin.git'), 'main');
  const main = join(root, 'main');
  commit(main, 'base');
  git(main, 'push', '-q', 'origin', 'HEAD:main');
  git(main, 'push', '-q', 'origin', 'HEAD:feat');
  git(main, 'fetch', '-q', 'origin');
  const earlier = join(root, 'earlier');
  const lap = join(root, 'lap');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', earlier, 'origin/feat');
  git(main, 'worktree', 'add', '-q', '-b', 'lap-2', lap, 'origin/main');
  return { root, earlier, lap };
}

describe('pushesCommit', () => {
  it('is a named commit the builder wants published, and nothing else', () => {
    expect(pushesCommit('BRANCH: b\nCOMMIT: abc1234\nPUBLISH: yes')).toBe(true);
    expect(pushesCommit('BRANCH: b\nCOMMIT: abc1234')).toBe(true);
    expect(pushesCommit('BRANCH: b\nCOMMIT: none\nPUBLISH: yes')).toBe(false);
    expect(pushesCommit('BRANCH: b\nCOMMIT: abc1234\nPUBLISH: no, the owner decides')).toBe(false);
  });
});

describe('takeBranch', () => {
  it('leaves a branch whose holder has a commit no remote has, and moves nothing', () => {
    const { earlier, lap } = repository();
    const unpushed = commit(earlier, 'fix');
    const tip = git(earlier, 'rev-parse', 'feat');
    const result = takeBranch('feat', lap);
    expect(result.ok).toBe('false');
    expect(result.reason).toContain(earlier);
    expect(result.reason).toContain(unpushed);
    expect(git(lap, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('lap-2');
    expect(git(earlier, 'rev-parse', 'feat')).toBe(tip);
    expect(holders('feat', lap)).toEqual([earlier]);
  });

  it('leaves a branch whose holder has uncommitted changes', () => {
    const { earlier, lap } = repository();
    writeFileSync(join(earlier, 'file.txt'), 'half done');
    const result = takeBranch('feat', lap);
    expect(result.ok).toBe('false');
    expect(result.reason).toContain(`${earlier} has uncommitted changes`);
    expect(git(lap, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('lap-2');
  });

  it('detaches a clean, pushed holder at its commit and checks the branch out at origin', () => {
    const { earlier, lap } = repository();
    commit(earlier, 'fix');
    git(earlier, 'push', '-q', 'origin', 'feat');
    const pushed = git(earlier, 'rev-parse', 'HEAD');
    const result = takeBranch('feat', lap);
    expect(result).toEqual({ ok: 'true', reason: expect.stringContaining(`detached ${earlier}`) as unknown as string });
    expect(git(earlier, 'rev-parse', 'HEAD')).toBe(pushed);
    expect(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: earlier }).status).not.toBe(0);
    expect(git(lap, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat');
    expect(git(lap, 'rev-parse', 'HEAD')).toBe(pushed);
    expect(holders('feat', lap)).toEqual([]);
  });

  it('takes a branch nobody holds, at the commit origin has now', () => {
    const { root, earlier, lap } = repository();
    git(earlier, 'checkout', '-q', '--detach');
    const other = join(root, 'other');
    git(root, 'clone', '-q', join(root, 'origin.git'), other);
    git(other, 'checkout', '-q', 'feat');
    const moved = commit(other, 'pushed elsewhere');
    git(other, 'push', '-q', 'origin', 'feat');
    expect(takeBranch('feat', lap).ok).toBe('true');
    expect(git(lap, 'rev-parse', '--short', 'HEAD')).toBe(moved);
  });
});

describe('release', () => {
  it('names a commit no remote has on a branch the run checked out, wherever its checkout is now', () => {
    const { earlier } = repository();
    const unpushed = commit(earlier, 'fix');
    // The app check leaves the checkout detached on a local merge.
    git(earlier, 'checkout', '-q', '--detach');
    expect(leftBehind(earlier)).toContain(`feat has 1 commit(s) no origin ref has: ${unpushed}`);
  });

  it('keeps nothing once the work is pushed', () => {
    const { earlier } = repository();
    commit(earlier, 'fix');
    git(earlier, 'push', '-q', 'origin', 'feat');
    expect(leftBehind(earlier)).toBeUndefined();
  });

  it('keeps the claim live and replaces an earlier note on a resumed run', () => {
    const body = `${CLAIM_PREFIX}run-1\n\nRoute: continue`;
    const first = keptClaim(body, 'feat has 1 commit(s) no origin ref has: 4f75080');
    expect(first.startsWith(`${CLAIM_PREFIX}run-1\n`)).toBe(true);
    expect(first).toContain('4f75080');
    const second = keptClaim(first, 'feat has 2 commit(s) no origin ref has: 9aa1111, 4f75080');
    expect(second).toContain('9aa1111');
    expect(second.match(/Kept as the run ended/g)).toHaveLength(1);
  });
});

describe('pre-review on a checkout off the builder branch', () => {
  function preReview(cwd: string, builder: string): { status: number | null; stdout: string; stderr: string } {
    const artifacts = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-branch-guard-artifacts-')));
    const result = spawnSync(process.execPath, [PRE_REVIEW], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ARTIFACTS_DIR: artifacts, INPUTS_BUILDER: builder, INPUTS_PR: '', INPUTS_TARGET: '' },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('passes a move that committed nothing', () => {
    const { lap } = repository();
    const run = preReview(lap, 'BRANCH: feat\nCOMMIT: none\nPR: https://github.com/example/app/pull/7\nPUBLISH: yes');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout) as { clean: string }).toMatchObject({ clean: 'true' });
  });

  it('still refuses a real commit', () => {
    const { lap } = repository();
    const run = preReview(lap, `BRANCH: feat\nCOMMIT: ${git(lap, 'rev-parse', 'HEAD')}\nPUBLISH: yes`);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("the checkout is on lap-2, not on the builder's branch feat");
  });
});
