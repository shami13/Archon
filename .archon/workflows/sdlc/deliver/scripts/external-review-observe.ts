/**
 * Request and wait for a Copilot review of the head this run pushed.
 *
 * The head is the checkout the engine observed when this node started, and it must
 * already be the pull request's head: a review of any other commit is not a review
 * of what this run delivers. The wait is bounded in-process (a `wait:` node cannot
 * sit between this and the correction that follows it in one loop iteration). A
 * refusal leaves the durable report behind before the node fails, and so does an
 * observation, since the triage agent that reads it next can fail too.
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
  reportStop,
  writeObservation,
} from '../../.shared/external-review.ts';
import { parseQualifiedPr } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, runId, stateDir } from '../../.shared/io.ts';

const boundPr = process.env.INPUTS_PR;

try {
  const ref = parseQualifiedPr(boundPr);
  const ledger = Ledger.forPull(stateDir(), ref, runId());
  let head: string | undefined;
  try {
    const policy = externalReviewPolicy();
    if (policy.mode !== 'copilot') throw new Error('the external review gate is off for this run');
    assertCopilotHost(ref);
    assertIdentity(ghApi, policy.login);
    head = nodeStartCommit();
    const remote = readPull(ghApi, ref).head;
    if (remote !== head) {
      throw new Error(
        `the checkout is at ${head} but the pull request head is ${remote}; push this run's commits before requesting a review`
      );
    }
    const observed = await observeCopilotReview(ref, head, {
      github: ghApi,
      ledger,
      now: Date.now,
      sleep: ms => Bun.sleep(ms),
      waitMs: REVIEW_WAIT_MS,
      pollMs: POLL_INTERVAL_MS,
    });
    writeObservation(artifactsDir(), ledger, ref, observed);
    emit({
      review: observed.review.id,
      head: observed.review.head,
      url: observed.review.url,
      comments: observed.comments.length,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reportStop(ledger, { ref, status: 'stopped while observing', reason, head }));
  }
} catch (error) {
  refuse(`external-observe: ${error instanceof Error ? error.message : String(error)}`);
}
