import { describe, expect, it } from 'bun:test';
import type { CodexFinding, CodexReview } from '../../workflows/sdlc/.shared/codex-review';
import { summaryLine } from '../../workflows/sdlc/loop/scripts/pre-review';
import { canonicalRepoOfOrigin, gitSshCommand, probeShell, repoOfOrigin, sshProbeArgs } from '../../workflows/sdlc/.shared/builder-report';
import { abandonedContinuation, assertHeadInOrigin, refuseBaseBranch, reviewSection, samePullRequest } from '../../workflows/sdlc/loop/scripts/publish';

const HEAD = 'a'.repeat(40);

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
  it('is the summary line for a clean review', () => {
    expect(reviewSection(review(HEAD, []))).toBe('Codex pre-push review of aaaaaaa: approve, 0 advisory note(s). Looked at it.');
  });

  it('lists the blocking findings and leaves the advisory ones to the stored review', () => {
    const section = reviewSection(review(HEAD, [finding('P2', 'edge'), finding('P3', 'nit')]));
    expect(section).toContain('1 blocking finding(s), 1 advisory note(s)');
    expect(section).toContain('- [P2] edge (src/app.ts:12): it is wrong Fix: check it');
    expect(section).not.toContain('nit');
  });
});

describe('repoOfOrigin', () => {
  it('reads host and path from https and ssh remotes, with or without .git', () => {
    expect(repoOfOrigin('https://github.com/shami13/darunki.git')).toEqual({ host: 'github.com', path: 'shami13/darunki' });
    expect(repoOfOrigin('git@github.company.test:example/app')).toEqual({ host: 'github.company.test', path: 'example/app' });
    expect(repoOfOrigin('ssh://git@github.com:22/example/app.git\n')).toEqual({ host: 'github.com', path: 'example/app' });
    expect(repoOfOrigin('ssh://git@github.com/example/app.git')).toEqual({ host: 'github.com', path: 'example/app' });
    expect(repoOfOrigin('git@github.com:/example/app.git')).toEqual({ host: 'github.com', path: 'example/app' });
    expect(repoOfOrigin('https://git.example.com:8443/owner/repo.git')).toEqual({ host: 'git.example.com:8443', path: 'owner/repo' });
  });

  it('refuses a remote it cannot name', () => {
    expect(() => repoOfOrigin('/srv/git/app.git')).toThrow(/not a repository URL/);
  });
});

describe('refuseBaseBranch', () => {
  it('refuses a push of the base branch onto itself and lets any other branch through', () => {
    expect(() => { refuseBaseBranch('main', 'main'); }).toThrow('the base itself');
    expect(() => { refuseBaseBranch('feat/x', 'main'); }).not.toThrow();
  });
});

describe('abandonedContinuation', () => {
  it('is a PR: none report on a move that continues a pull request, and nothing else', () => {
    const url = 'https://github.com/example/repo/pull/7';
    expect(abandonedContinuation('BRANCH: b\nCOMMIT: abc\nPR: none because the owner must decide', url)).toBe(true);
    expect(abandonedContinuation('BRANCH: b\nCOMMIT: abc\nPR: none', '')).toBe(false);
    expect(abandonedContinuation(`BRANCH: b\nCOMMIT: abc\nPR: ${url}`, url)).toBe(false);
    expect(abandonedContinuation('BRANCH: b\nCOMMIT: abc', url)).toBe(false);
  });
});

describe('sshProbeArgs', () => {
  it('passes the remote user to ssh -G so a Match user rule resolves as Git does', () => {
    expect(sshProbeArgs('git@work-forge:owner/repo.git', 'work-forge')).toEqual(['-G', '-l', 'git', 'work-forge']);
    expect(sshProbeArgs('ssh://deploy@github.com:22/example/app.git', 'github.com')).toEqual(['-G', '-l', 'deploy', '-p', '22', 'github.com']);
    expect(sshProbeArgs('ssh://git@forge-alias:2222/owner/repo.git', 'forge-alias')).toEqual(['-G', '-l', 'git', '-p', '2222', 'forge-alias']);
    expect(sshProbeArgs('ssh://git@github.com/example/app.git', 'github.com')).toEqual(['-G', '-l', 'git', 'github.com']);
    expect(sshProbeArgs('work-forge:owner/repo', 'work-forge')).toEqual(['-G', 'work-forge']);
  });
});

describe('gitSshCommand', () => {
  it('prefers GIT_SSH_COMMAND as shell text, then GIT_SSH as one quoted path, then ssh', () => {
    expect(gitSshCommand({ GIT_SSH_COMMAND: 'SSH_AUTH_SOCK=/a ssh -o "HostName=github.com"', GIT_SSH: '/x/ssh' })).toBe('SSH_AUTH_SOCK=/a ssh -o "HostName=github.com"');
    // No repository and no global or system config: the developer's own core.sshCommand must not decide this test.
    const bare = { GIT_DIR: '/nonexistent/.git', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    expect(gitSshCommand({ ...bare, GIT_SSH: "/x/it's ssh" })).toBe("'/x/it'\\''s ssh'");
    expect(gitSshCommand(bare)).toBe('ssh');
  });
});

describe('canonicalRepoOfOrigin', () => {
  it('resolves an alias through the ssh command Git itself would run, environment assignment included', () => {
    const before = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = 'SSH_AUTH_SOCK=/nonexistent/agent.sock ssh -o HostName=github.com';
    try {
      expect(canonicalRepoOfOrigin('git@review-work-alias:example/repo.git')).toEqual({ host: 'github.com', path: 'example/repo' });
    } finally {
      if (before === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = before;
    }
  });
});

describe('samePullRequest', () => {
  it('matches two spellings of one pull request and tells another apart', () => {
    expect(samePullRequest('https://github.com/Example/Repo/pull/7/', 'https://github.com/example/repo/pull/7')).toBe(true);
    expect(samePullRequest('https://github.com/example/repo/pull/7', 'https://github.com/example/repo/pull/8')).toBe(false);
    expect(samePullRequest('https://github.com/example/repo/pull/7', 'https://github.com/example/other/pull/7')).toBe(false);
  });
});

describe('probeShell', () => {
  it('takes ARCHON_BASH_PATH first, Git Bash on Windows, sh elsewhere', () => {
    expect(probeShell({ ARCHON_BASH_PATH: '/opt/bash' }, 'win32')).toBe('/opt/bash');
    expect(probeShell({}, 'linux')).toBe('sh');
    expect(probeShell({ ProgramFiles: 'C:\\PF' }, 'win32')).toBe('C:\\PF\\Git\\bin\\bash.exe');
  });

  it('leaves the alias as written when no shell can run the probe', () => {
    const before = process.env.ARCHON_BASH_PATH;
    process.env.ARCHON_BASH_PATH = '/nonexistent/bash';
    try {
      expect(canonicalRepoOfOrigin('git@work-alias:example/repo.git')).toEqual({ host: 'work-alias', path: 'example/repo' });
    } finally {
      if (before === undefined) delete process.env.ARCHON_BASH_PATH;
      else process.env.ARCHON_BASH_PATH = before;
    }
  });
});

describe('assertHeadInOrigin', () => {
  const origin = { host: 'github.com', path: 'example/repo' };
  it('lets a head in origin through and refuses a fork or an unnamed head repository', () => {
    expect(() => { assertHeadInOrigin('u', { host: 'GitHub.com', path: 'Example/Repo' }, origin); }).not.toThrow();
    expect(() => { assertHeadInOrigin('u', { host: 'github.com', path: 'someone/repo' }, origin); }).toThrow('pushes to origin only');
    expect(() => { assertHeadInOrigin('u', null, origin); }).toThrow('names no head repository');
  });
});
