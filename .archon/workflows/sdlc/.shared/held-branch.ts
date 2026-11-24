/**
 * Work on a branch that exists only on this machine.
 *
 * Every lap of the loop gets its own worktree of one repository, so the branch refs are
 * shared: a branch that one worktree has checked out, or that holds commits no remote has,
 * is another run's unpushed work. The lap checkout and the claim release read it here, so
 * a second worktree never takes such a branch and a claim is never released over it.
 */
import { realpathSync } from 'node:fs';

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { ok: result.exitCode === 0, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
}

function must(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.err}`);
  return result.out;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The worktrees other than `self` that have `branch` checked out, as `git worktree list` names them. */
export function holders(branch: string, self: string): string[] {
  const me = real(self);
  const found: string[] = [];
  let path = '';
  for (const line of must(self, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && real(path) !== me) found.push(path);
  }
  return found;
}

/**
 * The commits origin advertises now (every ref `git ls-remote origin` lists, pull request heads
 * included) that this repository has, or undefined when origin cannot be listed. A cached
 * remote-tracking ref is not trusted: one whose branch origin deleted still names its commit.
 */
function advertised(cwd: string): string[] | undefined {
  const listed = git(cwd, ['ls-remote', 'origin']);
  if (!listed.ok) return undefined;
  const shas = [...new Set(listed.out.split('\n').map(line => line.split('\t', 1)[0] ?? ''))].filter(sha => /^[0-9a-f]{40,64}$/.test(sha));
  const present = Bun.spawnSync(['git', '-C', cwd, 'cat-file', '--batch-check'], { stdin: Buffer.from(`${shas.join('\n')}\n`), stdout: 'pipe' });
  return present.stdout
    .toString()
    .split('\n')
    .filter(line => / commit \d+$/.test(line))
    .map(line => line.split(' ', 1)[0] ?? '');
}

/**
 * What of `branch` exists nowhere but here: its commits no ref origin advertises now reaches
 * (short SHAs, newest first) and the given worktrees with uncommitted or untracked changes.
 * Undefined when there is none. origin's copy of the branch is fetched first, so its commits are
 * here to compare with; when origin cannot be listed, nothing can be proven saved and the
 * branch's commits beyond the cached origin refs are named with that reason.
 */
export function unsavedWork(branch: string, worktrees: readonly string[], cwd: string): string | undefined {
  // A failed fetch (the branch was never pushed, or origin is down) leaves the older objects: that only over-reports.
  git(cwd, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const exists = git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  const remote = exists ? advertised(cwd) : [];
  let commits: string[] = [];
  if (exists) {
    const listing = Bun.spawnSync(['git', '-C', cwd, 'rev-list', '--abbrev-commit', `refs/heads/${branch}`, '--stdin'], {
      stdin: Buffer.from((remote ?? []).map(sha => `^${sha}\n`).join('')),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (listing.exitCode !== 0) throw new Error(`git rev-list ${branch} failed: ${listing.stderr.toString().trim()}`);
    commits = listing.stdout.toString().split('\n').filter(Boolean);
  }
  const dirty = worktrees.filter(worktree => must(worktree, ['status', '--porcelain', '--untracked-files=all']) !== '');
  const parts = [
    ...(remote === undefined ? [`origin could not be listed, so no commit of ${branch} is proven saved`] : []),
    ...(commits.length > 0 ? [`${branch} has ${String(commits.length)} commit(s) no origin ref has: ${commits.join(', ')}`] : []),
    ...dirty.map(worktree => `${worktree} has uncommitted changes`),
  ];
  return parts.length === 0 ? undefined : parts.join('; ');
}

/**
 * The local branches this worktree has had checked out, newest first: its current branch and
 * every branch its own HEAD log moved from or to. A run's worktree is its own, so these are the
 * branches the run worked on, whatever its builder reported or however it failed.
 */
export function visitedBranches(cwd: string): string[] {
  const names = [git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).out];
  for (const line of git(cwd, ['reflog', 'show', '--format=%gs', 'HEAD']).out.split('\n')) {
    const moved = /^checkout: moving from (\S+) to (\S+)$/.exec(line);
    if (moved !== null) names.push(moved[2], moved[1]);
  }
  return [...new Set(names)].filter(name => name !== '' && git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).ok);
}
