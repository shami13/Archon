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
  const value = rawLine(report, key);
  if (value === undefined || /^none\b/i.test(value)) return undefined;
  if (key === 'PR') return /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.exec(value)?.[0];
  return value;
}

/** The last `KEY: value` line as written (backticks around it tolerated), or undefined when there is none. */
export function rawLine(report: string, key: 'BRANCH' | 'COMMIT' | 'PR'): string | undefined {
  const matches = [...report.matchAll(new RegExp(`^\`?${key}:[ \\t]*(.+?)\`?[ \\t]*$`, 'gm'))];
  const value = matches[matches.length - 1]?.[1];
  return value === undefined || value === '' ? undefined : value;
}

export const CODEX_REVIEW_HEADING = '## Codex review';

/**
 * `body` with its `## Codex review` section replaced by `section`, or with the section
 * appended when the body has none. The section runs to the next `## ` heading.
 */
export function withCodexReviewSection(body: string, section: string): string {
  const block = `${CODEX_REVIEW_HEADING}\n\n${section.trim()}\n`;
  const lines = body.split('\n');
  // Headings on lines of their own, outside fenced code; a mention in prose or an example in a fence is neither.
  const headings: number[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && line.startsWith('## ')) headings.push(index);
  });
  const start = headings.find(index => lines[index]?.trimEnd() === CODEX_REVIEW_HEADING);
  if (start === undefined) return `${body.replace(/\s+$/, '')}\n\n${block}`;
  const end = headings.find(index => index > start) ?? lines.length;
  const before = lines.slice(0, start).join('\n');
  const after = lines.slice(end).join('\n');
  return `${before === '' ? '' : `${before}\n`}${block}${after === '' ? '' : `\n${after}`}`;
}
