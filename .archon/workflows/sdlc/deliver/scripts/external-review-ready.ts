/**
 * The external review's word on the head about to be flipped ready.
 *
 * Re-reads the pull request head rather than trusting the loop that produced the
 * verdict: a CI correction or an outside push after the review leaves a head no
 * Copilot review judged. The head is handed to flip-ready, which compares it again
 * at the flip.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`.
 */

import { Ledger, assertCopilotHost, ghApi, readPull, reportStop } from '../../.shared/external-review.ts';
import { parseQualifiedPr } from '../../.shared/forge.ts';
import { emit, refuse, runId, stateDir } from '../../.shared/io.ts';

const boundPr = process.env.INPUTS_PR;

try {
  const ref = parseQualifiedPr(boundPr);
  const ledger = Ledger.forPull(stateDir(), ref, runId());
  let head: string | undefined;
  try {
    assertCopilotHost(ref);
    head = readPull(ghApi, ref).head;
    if (!ledger.ready(head)) {
      const open = ledger.unverifiedCorrection();
      throw new Error(
        open === undefined
          ? `no clean or adjudicated Copilot review covers the pull request head ${head}`
          : `the correction for Copilot review ${open} has not passed the internal review, so its blocking findings remain open`
      );
    }
    emit({ head });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reportStop(ledger, { ref, status: 'not ready', reason, head }));
  }
} catch (error) {
  refuse(`external-review-ready: ${error instanceof Error ? error.message : String(error)}`);
}
