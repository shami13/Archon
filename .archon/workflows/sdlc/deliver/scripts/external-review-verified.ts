/**
 * Close one external correction cycle: only an internal continuation review that
 * found nothing open (`none`) passes, and only then does the ledger record that this
 * Copilot review's findings were judged. That record is what lets an unchanged head
 * pass later as adjudicated, and its absence keeps the cycle open in the ledger, so
 * a resumed run cannot pass on a newer review while these blockers stand.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`.
 * - INPUTS_REVIEW, INPUTS_HEAD: the observe node's review id and head.
 * - INPUTS_REVIEW_ACTION: the internal recheck's action.
 */

import { Ledger, reportStop, reviewerName } from '../../.shared/external-review.ts';
import { parseQualifiedPr } from '../../.shared/forge.ts';
import { emit, refuse, runId, stateDir, trimmed } from '../../.shared/io.ts';

const boundPr = process.env.INPUTS_PR;
const review = trimmed(process.env.INPUTS_REVIEW);
const head = trimmed(process.env.INPUTS_HEAD);
const action = trimmed(process.env.INPUTS_REVIEW_ACTION);

try {
  const ref = parseQualifiedPr(boundPr);
  const ledger = Ledger.forPull(stateDir(), ref, runId());
  try {
    if (action !== 'none') {
      throw new Error(
        `the internal review of the correction for ${reviewerName()} review ${review} returned "${action}", so blocking findings remain open; the canonical review report lists them, and this run does not flip the pull request ready`
      );
    }
    ledger.append({ event: 'verified', review, head });
    emit({ verified: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reportStop(ledger, { ref, status: 'correction not verified', reason, head }));
  }
} catch (error) {
  refuse(`external-verified: ${error instanceof Error ? error.message : String(error)}`);
}
