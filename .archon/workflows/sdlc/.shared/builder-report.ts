import { existsSync } from 'node:fs';
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
export function reportLine(report: string, key: 'BRANCH' | 'COMMIT' | 'PR' | 'PUBLISH'): string | undefined {
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
export function rawLine(report: string, key: 'BRANCH' | 'COMMIT' | 'PR' | 'PUBLISH'): string | undefined {
  const matches = [...report.matchAll(new RegExp(`^\`?${key}:[ \\t]*(.+?)\`?[ \\t]*$`, 'gm'))];
  const value = matches[matches.length - 1]?.[1];
  return value === undefined || value === '' ? undefined : value;
}

/** The builder's own publication decision: `PUBLISH: no` keeps a commit it made off origin, on either route. */
export function publicationDeclined(report: string): boolean {
  return /^no\b/i.test(rawLine(report, 'PUBLISH') ?? '');
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
  // An HTML comment block hides its lines too: a template's commented example of the heading is not the section.
  let comment = false;
  lines.forEach((line, index) => {
    if (comment) {
      if (line.includes('-->')) comment = false;
      return;
    }
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
    // An unclosed `<!--` anywhere on the line starts a comment block; what stands before it still counts here.
    const open = line.indexOf('<!--');
    if (open !== -1 && !line.includes('-->', open + 4)) comment = true;
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
  let output = '';
  try {
    const probe = Bun.spawnSync([probeShell(), '-c', `${gitSshCommand()} "$@"`, 'sh', ...sshProbeArgs(remote, repo.host)], { stdout: 'pipe', stderr: 'ignore' });
    if (probe.exitCode === 0) output = probe.stdout.toString();
  } catch {
    // No shell to probe with: the alias stays as written, as it did before the probe existed.
  }
  const hostname = /^hostname (\S+)$/m.exec(output)?.[1];
  return hostname === undefined ? repo : { host: forgeHost(hostname), path: repo.path };
}

/**
 * The shell that runs the probe: ARCHON_BASH_PATH when set, Git Bash where Windows installs it,
 * plain sh elsewhere. shortcut: mirrors resolveBashPath in packages/git, upgrade when this pack
 * may import @archon/git.
 */
export function probeShell(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (env.ARCHON_BASH_PATH) return env.ARCHON_BASH_PATH;
  if (platform !== 'win32') return 'sh';
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const candidates = [
    `${programFiles}\\Git\\bin\\bash.exe`,
    `${programFiles}\\Git\\usr\\bin\\bash.exe`,
    `${env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Git\\bin\\bash.exe`,
    ...(env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`] : []),
    ...(env.USERPROFILE ? [`${env.USERPROFILE}\\scoop\\apps\\git\\current\\bin\\bash.exe`] : []),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0] ?? 'bash';
}

/**
 * The command Git connects with, as the shell text Git itself runs: GIT_SSH_COMMAND, else
 * core.sshCommand, else GIT_SSH (one program path, quoted), else plain ssh. Shell text keeps
 * its semantics, such as a leading environment assignment, because a shell runs it.
 */
export function gitSshCommand(env: NodeJS.ProcessEnv = process.env): string {
  const command = env.GIT_SSH_COMMAND?.trim();
  if (command) return command;
  // The given environment, so GIT_DIR and GIT_CONFIG_* select the configuration as they do for Git itself.
  const configured = Bun.spawnSync(['git', 'config', '--get', 'core.sshCommand'], { env: { ...env, PATH: env.PATH ?? process.env.PATH ?? '' }, stdout: 'pipe', stderr: 'ignore' });
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
  const url = value.includes('://') ? safeUrl(value) : undefined;
  const user = url === undefined ? /^([^@/]+)@[^/:]+:/.exec(value)?.[1] : url.username;
  // The port travels too: a `Match exec` rule may read %p.
  return ['-G', ...(user ? ['-l', decodeURIComponent(user)] : []), ...(url?.port ? ['-p', url.port] : []), host];
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
