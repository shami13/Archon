/**
 * Decide what the observed Copilot review lets delivery do, and record it.
 *
 * Findings are every inline comment on the review plus the concerns the triage
 * agent found in its overview; the agent never removes an inline comment, so
 * dismissing one takes a correction cycle and the internal review's agreement.
 * `correct` starts a cycle; `clean` and `adjudicated` pass; every other verdict
 * refuses with the durable report written first. The ledger, not this script's
 * reading of it, settles which run may spend a correction cycle on the review.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`.
 * - INPUTS_REVIEW, INPUTS_HEAD: the observe node's review id and head.
 * - INPUTS_OUTCOME, INPUTS_REASON: the triage agent's typed reading of the review.
 * - INPUTS_OVERVIEW: the triage agent's overview findings, a JSON array.
 * - INPUTS_CORRECTIONS: "allowed", or "none" for a verification-only review.
 */

import {
  Ledger,
  MAX_CORRECTIONS,
  ROUTE_ACTIONS,
  TRIAGE_OUTCOMES,
  decide,
  findingsOf,
  readFeedback,
  reportStop,
  reviewerName,
  reviewerOf,
  writeFindings,
  writeReport,
  type RouteAction,
  type Verdict,
} from '../../.shared/external-review.ts';
import { parseQualifiedPr, record, type QualifiedPr } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, runId, stateDir, trimmed } from '../../.shared/io.ts';

const boundPr = process.env.INPUTS_PR;
const review = trimmed(process.env.INPUTS_REVIEW);
const head = trimmed(process.env.INPUTS_HEAD);
const outcome = trimmed(process.env.INPUTS_OUTCOME);
const reason = trimmed(process.env.INPUTS_REASON).replace(/\.+$/, '');
const overview = trimmed(process.env.INPUTS_OVERVIEW);
const corrections = trimmed(process.env.INPUTS_CORRECTIONS);

const REFUSALS: Record<Exclude<Verdict, RouteAction>, (holder: string | undefined) => string> = {
  unavailable: () => `${reviewerName()} did not review the change`,
  exhausted: () => 'findings remain open and this pull request has used every correction cycle',
  claimed: holder =>
    `run ${String(holder)} already holds the correction cycle for this review, so this run does not correct it too; resume that run, or, if it no longer runs, request a new ${reviewerName()} review of this head and resume this one`,
  blocked: () =>
    'findings remain open on the verification review of the final head and no correction cycle remains for it',
};

function isRouteAction(verdict: Verdict): verdict is RouteAction {
  return (ROUTE_ACTIONS as readonly string[]).includes(verdict);
}

function overviewFindings(): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(overview);
  } catch {
    throw new Error('the overview findings are not a JSON array');
  }
  if (!Array.isArray(parsed)) throw new Error('the overview findings are not a JSON array');
  return parsed.map(item => {
    const summary = record(item)?.summary;
    if (typeof summary !== 'string' || summary.trim() === '') {
      throw new Error('an overview finding has no summary');
    }
    return summary.trim();
  });
}

function isOutcome(value: string): value is (typeof TRIAGE_OUTCOMES)[number] {
  return (TRIAGE_OUTCOMES as readonly string[]).includes(value);
}

function route(ref: QualifiedPr, ledger: Ledger): void {
  if (!isOutcome(outcome)) {
    throw new Error(`the triage outcome must be one of ${TRIAGE_OUTCOMES.join(', ')}, not "${outcome}"`);
  }
  if (corrections !== 'allowed' && corrections !== 'none') {
    throw new Error(`corrections must be "allowed" or "none", not "${corrections}"`);
  }
  const feedback = readFeedback(artifactsDir(), review, head);
  const findings = findingsOf(feedback.comments, outcome === 'reviewed' ? overviewFindings() : [], reviewerOf());
  const unverified = ledger.unverifiedCorrection();
  writeFindings(artifactsDir(), feedback, findings, unverified);
  const decision = ledger.recordVerdict({
    review,
    head,
    verdict: decide({ review, outcome, findings, allowCorrection: corrections === 'allowed', ledger }),
    findings: findings.length,
  });
  const open =
    unverified === undefined
      ? ''
      : ` The correction for ${reviewerName()} review ${unverified} has not passed the internal review, so its blocking findings are open too.`;
  const state = { ref, status: decision.verdict, head, reviewUrl: feedback.review.url, findings };
  const verdict = decision.verdict;
  if (!isRouteAction(verdict)) {
    const stop = `${REFUSALS[verdict](ledger.correctionHolder(review))} (${feedback.review.url}): ${reason}.${open}`;
    refuse(`external-route: ${reportStop(ledger, { ...state, reason: stop })}`);
    return;
  }
  writeReport(artifactsDir(), ledger, {
    ...state,
    reason:
      verdict === 'correct'
        ? `${reason}.${open} This run holds a correction cycle, ${String(decision.corrections)} of ${String(MAX_CORRECTIONS)} now in use, and runs it next: the fix, its green gate, then the internal review of the correction. If the run stopped after this report, one of those stages failed and the findings below remain open.`
        : reason,
  });
  emit({ action: verdict, corrections: decision.corrections });
}

try {
  const ref = parseQualifiedPr(boundPr);
  const ledger = Ledger.forPull(stateDir(), ref, runId());
  try {
    route(ref, ledger);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reportStop(ledger, { ref, status: 'stopped while routing', reason, head }));
  }
} catch (error) {
  refuse(`external-route: ${error instanceof Error ? error.message : String(error)}`);
}
