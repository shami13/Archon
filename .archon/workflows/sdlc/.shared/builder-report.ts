import { pullRefOf } from './external-review.ts';

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
  if (key === 'PR') {
    // The same parser the forge uses, so a URL it accepts (a port, a trailing slash) is a pull request here too.
    try {
      pullRefOf(value);
      return value;
    } catch {
      return undefined;
    }
  }
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
  const text = body.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
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
    if (/^ {0,3}#{1,2}[ \t]/.test(line)) headings.push(index);
    // A Setext heading: a text line underlined with = or - on the next line.
    else if (line.trim() !== '' && !/^ {0,3}(?:[-*+]|\d+[.)]) /.test(line) && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[index + 1] ?? '')) headings.push(index);
  });
  const start = headings.find(index => lines[index]?.trim() === CODEX_REVIEW_HEADING);
  if (start === undefined) return `${text.replace(/\s+$/, '')}\n\n${block}`;
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
    // An http(s) service on another port is another service; ssh ports only choose a transport.
    host = /^https?:$/.test(url.protocol) ? url.host : url.hostname;
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
  // Git's own ssh command, so an alias or option it carries (-o HostName=...) counts here as it does for the push.
  const probe = Bun.spawnSync(['sh', '-c', `${gitSshCommand()} "$@"`, 'sh', ...sshProbeArgs(remote, repo.host)], { stdout: 'pipe', stderr: 'ignore' });
  const hostname = /^hostname (\S+)$/m.exec(probe.stdout.toString())?.[1];
  return hostname === undefined || probe.exitCode !== 0 ? repo : { host: forgeHost(hostname), path: repo.path };
}

/**
 * The command Git connects with, as the shell text Git itself runs: GIT_SSH_COMMAND, else
 * core.sshCommand, else GIT_SSH (one program path, quoted), else plain ssh. Shell text keeps
 * its semantics, such as a leading environment assignment, because a shell runs it.
 */
export function gitSshCommand(env: NodeJS.ProcessEnv = process.env): string {
  const command = env.GIT_SSH_COMMAND?.trim();
  if (command) return command;
  const configured = Bun.spawnSync(['git', 'config', '--get', 'core.sshCommand'], { stdout: 'pipe', stderr: 'ignore' });
  const value = configured.stdout.toString().trim();
  if (configured.exitCode === 0 && value !== '') return value;
  const legacy = env.GIT_SSH?.trim();
  return legacy ? `'${legacy.replace(/'/g, "'\\''")}'` : 'ssh';
}

/**
 * The `ssh -G` arguments that evaluate the destination Git itself uses: the user travels with the
 * host, because a `Match user` rule may pick the Hostname.
 */
export function sshProbeArgs(remote: string, host: string): string[] {
  const value = remote.trim();
  const user = value.includes('://') ? safeUrl(value)?.username : /^([^@/]+)@[^/:]+:/.exec(value)?.[1];
  return ['-G', ...(user ? ['-l', decodeURIComponent(user)] : []), host];
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** The forge a transport host belongs to: GitHub's SSH-over-443 endpoint is github.com to the forge. */
export function forgeHost(hostname: string): string {
  const host = hostname.toLowerCase();
  return host === 'ssh.github.com' ? 'github.com' : host;
}
