/**
 * Close one external correction cycle: only an internal continuation review that
 * found nothing open (`none`) passes, and only then does the ledger record that this
 * Copilot review's findings were judged. That record is what lets an unchanged head
 * pass later as adjudicated, so it is written after the verdict, never before.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`.
 * - INPUTS_REVIEW, INPUTS_HEAD: the observe node's review id and head.
 * - INPUTS_REVIEW_ACTION: the internal recheck's action.
 */

import { Ledger, writeReport } from '../../.shared/external-review.ts';
import { parseQualifiedPr } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, runId, stateDir, trimmed } from '../../.shared/io.ts';

const boundPr = process.env.INPUTS_PR;
const review = trimmed(process.env.INPUTS_REVIEW);
const head = trimmed(process.env.INPUTS_HEAD);
const action = trimmed(process.env.INPUTS_REVIEW_ACTION);

try {
  const ref = parseQualifiedPr(boundPr);
  const ledger = Ledger.forPull(stateDir(), ref, runId());
  if (action === 'none') {
    ledger.append({ event: 'verified', review, head });
    emit({ verified: true });
  } else {
    const reason = `the internal review of the correction for Copilot review ${review} returned "${action}", so blocking findings remain open`;
    writeReport(artifactsDir(), ledger, { ref, status: 'correction not verified', reason, head });
    refuse(
      `external-verified: ${reason}; the pull request stays draft. See the canonical review report and ${artifactsDir()}/external-review/report.md.`
    );
  }
} catch (error) {
  refuse(`external-verified: ${error instanceof Error ? error.message : String(error)}`);
}
