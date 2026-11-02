/**
 * Request and wait for a Copilot review of the head this run pushed.
 *
 * The head is the checkout the engine observed when this node started, and it must
 * already be the pull request's head: a review of any other commit is not a review
 * of what this run delivers. The wait is bounded in-process (a `wait:` node cannot
 * sit between this and the correction that follows it in one loop iteration), and
 * every refusal leaves the durable report behind before the node fails.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 */

import { nodeStartCommit } from '../../.shared/checkout.ts';
import {
  Ledger,
  POLL_INTERVAL_MS,
  REVIEW_WAIT_MS,
  assertCopilotHost,
  assertIdentity,
  externalReviewPolicy,
  ghApi,
  observeCopilotReview,
  readPull,
  writeFeedback,
  writeReport,
} from '../../.shared/external-review.ts';
import { parseQualifiedPr } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, runId, stateDir } from '../../.shared/io.ts';

const boundPr = process.env.INPUTS_PR;

async function observe(): Promise<void> {
  const ref = parseQualifiedPr(boundPr);
  const ledger = Ledger.forPull(stateDir(), ref, runId());
  let head: string | undefined;
  try {
    const policy = externalReviewPolicy();
    if (policy.mode !== 'copilot') throw new Error('the external review gate is off for this run');
    assertCopilotHost(ref);
    const github = ghApi(ref.repo.host);
    assertIdentity(github, policy.login);
    head = nodeStartCommit();
    const remote = readPull(github, ref).head;
    if (remote !== head) {
      throw new Error(
        `the checkout is at ${head} but the pull request head is ${remote}; push this run's commits before requesting a review`
      );
    }
    const observed = await observeCopilotReview(ref, head, {
      github,
      ledger,
      now: Date.now,
      sleep: ms => Bun.sleep(ms),
      waitMs: REVIEW_WAIT_MS,
      pollMs: POLL_INTERVAL_MS,
    });
    const { head: reviewed, ...review } = observed.review;
    writeFeedback(artifactsDir(), { pr: ref, head: reviewed, review, comments: observed.comments });
    emit({
      review: review.id,
      head: reviewed,
      url: review.url,
      comments: observed.comments.length,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeReport(artifactsDir(), ledger, { ref, status: 'stopped while observing', reason, head });
    refuse(`external-observe: ${reason}`);
  }
}

await observe().catch((error: unknown) => {
  refuse(`external-observe: ${error instanceof Error ? error.message : String(error)}`);
});
