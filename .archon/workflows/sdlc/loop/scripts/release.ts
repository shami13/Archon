/**
 * Release this run's claim on its work item, whatever happened in the run, unless the run
 * leaves work behind that no remote has.
 *
 * Runs after review (and deploy) have finished, failed or been skipped, so a run that
 * broke part-way still frees the item for the next lap. When a branch the run's checkout was
 * on holds commits no origin ref has, or the checkout on it has uncommitted changes, the
 * claim stays live (it expires after `claim_hours`) and says what is kept, so no other lap
 * takes the branch over that work; the run can be resumed, or the work pushed or discarded.
 * Only this run's own live claim is touched; a claim another run holds is never edited here.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_TARGET, INPUTS_PR: the work item and the pull request the move continued.
 */

import { CLAIM_PREFIX, KEPT_NOTE, comments, editComment, workItem } from '../../.shared/claims.ts';
import { unsavedWork, visitedBranches } from '../../.shared/held-branch.ts';
import { report, trimmed } from '../../.shared/io.ts';

/** The claim body that stays live and names the work it keeps; a resumed run's earlier note is replaced. */
export function keptClaim(body: string, unsaved: string): string {
  return `${body.split(KEPT_NOTE, 1)[0]}${KEPT_NOTE}${unsaved}. Resume the run, or push or discard that work, then edit this comment to start with \`Loop claim released\`.`;
}

/** What the run's checkout leaves that no remote has, or undefined when its claim can be released. */
export function leftBehind(cwd: string): string | undefined {
  const current = Bun.spawnSync(['git', '-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { stdout: 'pipe' }).stdout.toString().trim();
  // The app check leaves the checkout detached on a local merge; uncommitted changes count only on a branch.
  const found = visitedBranches(cwd)
    .map(branch => unsavedWork(branch, branch === current ? [cwd] : [], cwd))
    .filter(text => text !== undefined);
  return found.length === 0 ? undefined : found.join('; ');
}

function release(): void {
  const target = trimmed(process.env.INPUTS_TARGET);
  const pr = trimmed(process.env.INPUTS_PR);
  const run = trimmed(process.env.WORKFLOW_ID);
  if (run === '') throw new Error('release: WORKFLOW_ID is not set; the engine supplies it to every exec node.');

  const item = workItem(target !== '' ? target : pr);
  const own = comments(item).filter(
    comment =>
      typeof comment.body === 'string' &&
      typeof comment.id === 'number' &&
      comment.body.startsWith(`${CLAIM_PREFIX}${run}`) &&
      /^\s/.test(comment.body.slice(`${CLAIM_PREFIX}${run}`.length) || ' ')
  );
  const unsaved = own.length > 0 ? leftBehind(process.cwd()) : undefined;
  for (const comment of own) {
    editComment(
      item,
      comment.id as number,
      unsaved !== undefined
        ? keptClaim(comment.body as string, unsaved)
        : `Loop claim released: run ${run} ended. Its \`Loop review:\` comment, if any, says what it did.`
    );
  }
  if (own.length === 0) report(`run ${run} held no claim on ${target || pr}`);
  else if (unsaved !== undefined) report(`kept ${String(own.length)} claim(s) on ${target || pr}: ${unsaved}`);
  else report(`released ${String(own.length)} claim(s) on ${target || pr}`);
}

if (import.meta.main) release();
