/**
 * Decide what the observed Copilot review lets delivery do, and record it.
 *
 * Findings are every inline comment on the review plus the concerns the triage
 * agent found in its overview; the agent never removes an inline comment, so
 * dismissing one takes a correction cycle and the internal review's agreement.
 * `correct` starts a cycle; `clean` and `adjudicated` pass; every other verdict
 * refuses with the durable report written first.
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
  decide,
  findingsOf,
  readFeedback,
  writeFindings,
  writeReport,
  type Verdict,
} from '../../.shared/external-review.ts';
import { parseQualifiedPr, record, type QualifiedPr } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, runId, stateDir, trimmed } from '../../.shared/io.ts';

const boundPr = process.env.INPUTS_PR;
const review = trimmed(process.env.INPUTS_REVIEW);
const head = trimmed(process.env.INPUTS_HEAD);
const outcome = trimmed(process.env.INPUTS_OUTCOME);
const reason = trimmed(process.env.INPUTS_REASON);
const overview = trimmed(process.env.INPUTS_OVERVIEW);
const corrections = trimmed(process.env.INPUTS_CORRECTIONS);

const REFUSALS: Partial<Record<Verdict, string>> = {
  unavailable: 'Copilot did not review the change',
  exhausted: 'the review still has findings and this pull request has used every correction cycle',
  blocked: 'the verification review of the final head has findings and no correction cycle remains for it',
};

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

function route(ref: QualifiedPr, ledger: Ledger): void {
  if (outcome !== 'reviewed' && outcome !== 'unavailable') {
    throw new Error(`the triage outcome must be "reviewed" or "unavailable", not "${outcome}"`);
  }
  if (corrections !== 'allowed' && corrections !== 'none') {
    throw new Error(`corrections must be "allowed" or "none", not "${corrections}"`);
  }
  const feedback = readFeedback(artifactsDir(), review, head);
  const findings = findingsOf(feedback.comments, outcome === 'reviewed' ? overviewFindings() : []);
  writeFindings(artifactsDir(), feedback, findings);
  const decision = decide({
    review,
    outcome,
    findings,
    allowCorrection: corrections === 'allowed',
    ledger,
  });
  ledger.append({
    event: 'verdict',
    review,
    head,
    verdict: decision.verdict,
    findings: findings.length,
    corrections: decision.corrections,
  });
  const refusal = REFUSALS[decision.verdict];
  writeReport(artifactsDir(), ledger, {
    ref,
    status: decision.verdict,
    reason: refusal ? `${refusal}: ${reason}` : reason,
    head,
    reviewUrl: feedback.review.url,
    findings,
  });
  if (refusal) {
    refuse(
      `external-route: ${refusal} (${feedback.review.url}): ${reason}. See ${artifactsDir()}/external-review/report.md.`
    );
  } else {
    emit({ action: decision.verdict, corrections: decision.corrections });
  }
}

try {
  const ref = parseQualifiedPr(boundPr);
  const ledger = Ledger.forPull(stateDir(), ref, runId());
  try {
    route(ref, ledger);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeReport(artifactsDir(), ledger, { ref, status: 'stopped while routing', reason, head });
    throw error;
  }
} catch (error) {
  refuse(`external-route: ${error instanceof Error ? error.message : String(error)}`);
}
