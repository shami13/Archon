/**
 * The few facts the loop reads out of the builder's free-text report, and the one
 * section it writes into a pull request body. The report stays prose for the reviewers;
 * only lines of the form `KEY: value` are read here.
 */

/**
 * The last `KEY: value` line of the report, or undefined when the report has none or says
 * `none` (with or without the sentence the builder adds after it). `PR` is a pull request URL
 * or nothing: the builder's explanation never passes as one.
 */
export function reportLine(report: string, key: 'BRANCH' | 'COMMIT' | 'PR'): string | undefined {
  const matches = [...report.matchAll(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'gm'))];
  const value = matches[matches.length - 1]?.[1];
  if (value === undefined || value === '' || /^none\b/i.test(value)) return undefined;
  if (key === 'PR') return /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.exec(value)?.[0];
  return value;
}

export const CODEX_REVIEW_HEADING = '## Codex review';

/**
 * `body` with its `## Codex review` section replaced by `section`, or with the section
 * appended when the body has none. The section runs to the next `## ` heading.
 */
export function withCodexReviewSection(body: string, section: string): string {
  const block = `${CODEX_REVIEW_HEADING}\n\n${section.trim()}\n`;
  const start = body.indexOf(CODEX_REVIEW_HEADING);
  if (start === -1) return `${body.replace(/\s+$/, '')}\n\n${block}`;
  const rest = body.slice(start + CODEX_REVIEW_HEADING.length);
  const next = rest.search(/^## /m);
  const end = next === -1 ? body.length : start + CODEX_REVIEW_HEADING.length + next;
  return `${body.slice(0, start)}${block}${next === -1 ? '' : '\n'}${body.slice(end)}`;
}
