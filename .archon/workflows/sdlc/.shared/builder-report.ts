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
  // Line endings are normalised first: a CRLF body would otherwise hide every fence behind its trailing \r.
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  // Headings on lines of their own, outside fenced code; a mention in prose or an example in a fence is neither.
  const headings: number[] = [];
  // A fence closes only with the same character, at least as long; a shorter or different run is content.
  let fence: { char: string; length: number } | undefined;
  lines.forEach((line, index) => {
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (run !== null && fence === undefined) {
      fence = { char: run[1]?.charAt(0) ?? '', length: run[1]?.length ?? 0 };
      return;
    }
    if (fence !== undefined) {
      // Only a run of the same character, at least as long, with nothing but blanks after it, closes the fence.
      const closes = run !== null && (run[1] ?? '').startsWith(fence.char) && (run[1]?.length ?? 0) >= fence.length && (run[2] ?? '').trim() === '';
      if (closes) fence = undefined;
      return;
    }
    // A level-one or level-two heading, indented up to three spaces as Markdown allows, ends a section.
    if (/^ {0,3}#{1,2} /.test(line)) headings.push(index);
  });
  const start = headings.find(index => lines[index]?.trim() === CODEX_REVIEW_HEADING);
  if (start === undefined) return `${body.replace(/\s+$/, '')}\n\n${block}`;
  const end = headings.find(index => index > start) ?? lines.length;
  const before = lines.slice(0, start).join('\n');
  const after = lines.slice(end).join('\n');
  return `${before === '' ? '' : `${before}\n`}${block}${after === '' ? '' : `\n${after}`}`;
}

/** The repository origin points at, host included, from an https, ssh:// or scp-style remote. */
export function repoOfOrigin(remote: string): { host: string; path: string } {
  const value = remote.trim();
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(value);
  let host: string;
  let path: string;
  if (scp !== null && !value.includes('://')) {
    [, host, path] = scp as unknown as [string, string, string];
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('origin is not a repository URL this loop can publish to');
    }
    host = url.hostname;
    path = url.pathname.replace(/^\/+/, '');
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  // The URL stays out of the message: a remote may carry a credential.
  if (host === '' || !/^[^/]+\/[^/]+$/.test(path)) throw new Error('origin is not a repository URL this loop can publish to');
  return { host: host.toLowerCase(), path };
}

/**
 * The repository origin points at with its SSH host alias resolved: `git@github-work:o/r` reaches
 * github.com when ~/.ssh/config says so, and the forge is asked about github.com, never about the alias.
 */
export function canonicalRepoOfOrigin(remote: string): { host: string; path: string } {
  const repo = repoOfOrigin(remote);
  if (/^https?:\/\//.test(remote.trim())) return repo;
  const probe = Bun.spawnSync(['ssh', '-G', repo.host], { stdout: 'pipe', stderr: 'ignore' });
  const hostname = /^hostname (\S+)$/m.exec(probe.stdout.toString())?.[1];
  return hostname === undefined || probe.exitCode !== 0 ? repo : { host: forgeHost(hostname), path: repo.path };
}

/** The forge a transport host belongs to: GitHub's SSH-over-443 endpoint is github.com to the forge. */
export function forgeHost(hostname: string): string {
  const host = hostname.toLowerCase();
  return host === 'ssh.github.com' ? 'github.com' : host;
}
