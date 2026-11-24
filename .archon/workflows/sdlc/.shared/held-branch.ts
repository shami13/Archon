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
 * What of `branch` exists nowhere but here: its commits no origin ref reaches (short SHAs,
 * newest first) and the given worktrees with uncommitted or untracked changes. Undefined when
 * there is none. origin's copy of the branch is fetched first, so a branch pushed meanwhile
 * does not count; a branch origin lacks keeps every commit the other origin refs lack.
 */
export function unsavedWork(branch: string, worktrees: readonly string[], cwd: string): string | undefined {
  // A failed fetch (the branch was never pushed, or origin is down) leaves the older refs: that only over-reports.
  git(cwd, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const exists = git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  const commits = exists ? must(cwd, ['rev-list', '--abbrev-commit', `refs/heads/${branch}`, '--not', '--remotes=origin']).split('\n').filter(Boolean) : [];
  const dirty = worktrees.filter(worktree => must(worktree, ['status', '--porcelain', '--untracked-files=all']) !== '');
  const parts = [
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
