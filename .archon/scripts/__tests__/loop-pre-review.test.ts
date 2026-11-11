import { describe, expect, it } from 'bun:test';
import type { CodexFinding, CodexReview } from '../../workflows/sdlc/.shared/codex-review';
import { summaryLine } from '../../workflows/sdlc/loop/scripts/pre-review';
import { reviewSection } from '../../workflows/sdlc/loop/scripts/publish';

const HEAD = 'a'.repeat(40);
const LATER = 'b'.repeat(40);

function finding(priority: string, title: string): CodexFinding {
  return { priority, title, path: 'src/app.ts', line: 12, problem: 'it is wrong', failure: 'a caller fails', fix: 'check it', confidence: 'high' } as CodexFinding;
}

function review(head: string, findings: CodexFinding[]): CodexReview {
  return { id: `codex-${head}`, head, base: 'main', reviewedAt: '2026-11-11T08:00:00.000Z', findings, assessment: 'Looked at it.' };
}

describe('summaryLine', () => {
  it('names the head, the verdict and the advisory count', () => {
    expect(summaryLine(HEAD, [finding('P3', 'nit')], 'Fine.')).toBe(
      'Codex pre-push review of aaaaaaa: approve, 1 advisory note(s). Fine.'
    );
    expect(summaryLine(HEAD, [finding('P1', 'bug'), finding('P2', 'edge')], 'Two.')).toBe(
      'Codex pre-push review of aaaaaaa: 2 blocking finding(s), 0 advisory note(s). Two.'
    );
  });
});

describe('reviewSection', () => {
  it('is the summary line for a clean review of the pushed head', () => {
    expect(reviewSection(HEAD, review(HEAD, []))).toBe('Codex pre-push review of aaaaaaa: approve, 0 advisory note(s). Looked at it.');
  });

  it('lists the blocking findings and says when the pushed head came after the review', () => {
    const section = reviewSection(LATER, review(HEAD, [finding('P2', 'edge'), finding('P3', 'nit')]));
    expect(section).toContain('1 blocking finding(s), 1 advisory note(s)');
    expect(section).toContain('The pushed commit bbbbbbb came after that review');
    expect(section).toContain('- [P2] edge (src/app.ts:12): it is wrong Fix: check it');
    expect(section).not.toContain('nit');
  });

  it('says so when no review was recorded', () => {
    expect(reviewSection(HEAD, undefined)).toBe('No Codex pre-push review of aaaaaaa was recorded.');
  });
});
