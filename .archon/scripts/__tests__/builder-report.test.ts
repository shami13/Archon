import { describe, expect, it } from 'bun:test';
import { rawLine, reportLine, withCodexReviewSection } from '../../workflows/sdlc/.shared/builder-report';

describe('reportLine', () => {
  it('reads the last KEY: value line of a report', () => {
    const report = 'Built it.\nBRANCH: feat/x\nCOMMIT: abc\nPR: none because nothing was pushed yet\nBRANCH: feat/y';
    expect(reportLine(report, 'BRANCH')).toBe('feat/y');
    expect(reportLine(report, 'COMMIT')).toBe('abc');
  });

  it('treats none, none with its sentence, and a missing line alike', () => {
    expect(reportLine('PR: none', 'PR')).toBeUndefined();
    expect(reportLine('PR: none because nothing has been pushed yet', 'PR')).toBeUndefined();
    expect(reportLine('nothing here', 'BRANCH')).toBeUndefined();
  });

  it('reads a line the builder wrapped in backticks, and tells a missing line from none', () => {
    expect(reportLine('`COMMIT: abc1234`', 'COMMIT')).toBe('abc1234');
    expect(rawLine('COMMIT: none', 'COMMIT')).toBe('none');
    expect(rawLine('Built it.', 'COMMIT')).toBeUndefined();
  });

  it('takes a pull request only as its URL', () => {
    expect(reportLine('PR: https://github.com/example/app/pull/9', 'PR')).toBe('https://github.com/example/app/pull/9');
    expect(reportLine('PR: the one I opened earlier', 'PR')).toBeUndefined();
  });
});

describe('withCodexReviewSection', () => {
  it('appends the section to a body without one', () => {
    expect(withCodexReviewSection('Closes #5\n\n## Evidence\n\n- C1: ok\n', 'Codex: approve')).toBe(
      'Closes #5\n\n## Evidence\n\n- C1: ok\n\n## Codex review\n\nCodex: approve\n'
    );
  });

  it('replaces an existing section up to the next heading', () => {
    const body = 'Closes #5\n\n## Codex review\n\nold line\n- [P2] old\n\n## Evidence\n\n- C1: ok\n';
    expect(withCodexReviewSection(body, 'new line')).toBe('Closes #5\n\n## Codex review\n\nnew line\n\n## Evidence\n\n- C1: ok\n');
  });

  it('leaves a mention of the heading in prose alone and appends a real section', () => {
    const body = 'The literal `## Codex review` heading is shown in the UI.\n\nRoll out slowly.\n\n## Evidence\n\n- C1: ok\n';
    expect(withCodexReviewSection(body, 'new')).toBe(`${body}\n## Codex review\n\nnew\n`);
  });

  it('leaves an example heading inside a fence alone', () => {
    const body = 'Intro\n\n```md\n## Codex review\n\nexample\n```\n\nRoll out slowly.\n';
    expect(withCodexReviewSection(body, 'new')).toBe(`${body}\n## Codex review\n\nnew\n`);
  });

  it('replaces a trailing section', () => {
    expect(withCodexReviewSection('Body\n\n## Codex review\n\nold\n', 'new')).toBe('Body\n\n## Codex review\n\nnew\n');
  });
});
