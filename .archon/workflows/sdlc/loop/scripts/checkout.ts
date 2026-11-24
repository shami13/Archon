/**
 * Put the run's checkout on the branch of the pull request a `continue` move finishes.
 *
 * Another worktree may have that branch checked out: a run that failed or ended. When the
 * branch or that worktree holds work no remote has (commits origin lacks, uncommitted
 * changes), the lap leaves the item (`ok: "false"`, the reason names the work) and nothing
 * moves. Otherwise each holder is detached at the commit it had, and the branch is checked
 * out here at origin's commit, so the builder starts on it and never forces a checkout.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: the pull request URL the move continues.
 */
import { canonicalRepoOfOrigin } from '../../.shared/builder-report.ts';
import { pullRefOf } from '../../.shared/external-review.ts';
import { forgeSource, sameRepo } from '../../.shared/forge.ts';
import { holders, unsavedWork } from '../../.shared/held-branch.ts';
import { emit, refuse, trimmed } from '../../.shared/io.ts';
import { viewPr } from '../../.shared/pr.ts';

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

/** Check `branch` out in `cwd` at origin's commit, unless work that exists only here is in the way. */
export function takeBranch(branch: string, cwd: string): { ok: 'true' | 'false'; reason: string } {
  if (git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) === branch) return { ok: 'true', reason: `the checkout is already on ${branch}` };
  const held = holders(branch, cwd);
  // Read before the check: the branch moves below only while it is still this commit.
  const tip = tipOf(branch, cwd);
  const unsaved = unsavedWork(branch, held, cwd);
  if (unsaved !== undefined) {
    const where = held.length > 0 ? ` (checked out in ${held.join(', ')})` : '';
    return { ok: 'false', reason: `${branch}${where} holds work no remote has: ${unsaved}; this lap leaves the item to the run that made it` };
  }
  if (Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).exitCode !== 0) {
    throw new Error(`origin has no branch ${branch}; there is nothing to check out`);
  }
  return moveBranch(branch, tip, held, cwd);
}

function tipOf(branch: string, cwd: string): string {
  const result = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { stdout: 'pipe' });
  return result.exitCode === 0 ? result.stdout.toString().trim() : '';
}

/**
 * Detach the holders, then move `branch` to origin's commit and check it out here, but only while
 * its tip is still `tip` (empty: the branch must not exist yet). A commit that landed on the branch
 * after the check keeps the branch where it is, and the lap leaves the item. A holder is a run that
 * ended; the claim this lap holds keeps any live run off the branch.
 */
export function moveBranch(branch: string, tip: string, held: readonly string[], cwd: string): { ok: 'true' | 'false'; reason: string } {
  for (const worktree of held) git(worktree, ['checkout', '--quiet', '--detach']);
  const target = git(cwd, ['rev-parse', `refs/remotes/origin/${branch}`]);
  const swapped = Bun.spawnSync(['git', '-C', cwd, 'update-ref', '-m', 'archon-loop checkout', `refs/heads/${branch}`, target, tip], { stderr: 'pipe' });
  if (swapped.exitCode !== 0) {
    return { ok: 'false', reason: `${branch} moved while this lap checked it (now ${tipOf(branch, cwd).slice(0, 7) || 'deleted'}); this lap leaves the item` };
  }
  git(cwd, ['checkout', '--quiet', branch]);
  git(cwd, ['branch', '--quiet', `--set-upstream-to=origin/${branch}`, branch]);
  const detached = held.length > 0 ? `; detached ${held.join(', ')}` : '';
  return { ok: 'true', reason: `checked out ${branch} at ${target.slice(0, 7)}${detached}` };
}

function checkout(): void {
  const url = trimmed(process.env.INPUTS_PR);
  const { pr } = viewPr(pullRefOf(url), forgeSource());
  if (pr.state !== 'open') {
    emit({ ok: 'false', branch: pr.head, reason: `${url} is ${pr.state}; there is nothing to continue` });
    return;
  }
  const origin = canonicalRepoOfOrigin(git(process.cwd(), ['remote', 'get-url', 'origin']));
  if (pr.head_repo === null || !sameRepo(pr.head_repo, origin)) {
    emit({ ok: 'false', branch: pr.head, reason: `${url} has its head outside ${origin.path}; this loop pushes to origin only` });
    return;
  }
  emit({ ...takeBranch(pr.head, process.cwd()), branch: pr.head });
}

if (import.meta.main) {
  try {
    checkout();
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
}
