/**
 * GitHub governance commands:
 * - `trueline github verify [--protect <paths>]`
 * - `trueline github merge [--branch <name>] [--allow <path>]`
 * - `trueline github init [--branch <name>]`
 *
 * Uses standard `fetch` against the GitHub REST API with zero extra dependencies.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AllowList } from '../allow/index.ts';
import type { Diagnostic, TruelineConfig } from '../model/types.ts';
import { loadConfig, parseConfigText } from '../workspace/config.ts';
import { verifyPullRequestPolicy } from './policy.ts';
import { mergeWorkflowTemplate, verifyWorkflowTemplate } from './workflows.ts';

export interface GithubCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface PullRequestEvent {
  readonly pull_request?: {
    readonly number?: number;
    readonly user?: { readonly login?: string };
    readonly head?: { readonly sha?: string };
  };
}

export function runGithubInit(cwd: string, branch = 'master'): GithubCommandResult {
  const wfDir = join(cwd, '.github', 'workflows');
  mkdirSync(wfDir, { recursive: true });
  const verifyPath = join(wfDir, 'trueline-verify.yml');
  const mergePath = join(wfDir, 'trueline-merge.yml');

  const lines: string[] = [];
  if (!existsSync(verifyPath)) {
    writeFileSync(verifyPath, verifyWorkflowTemplate(), 'utf8');
    lines.push('trueline: wrote .github/workflows/trueline-verify.yml');
  } else {
    lines.push('trueline: .github/workflows/trueline-verify.yml already exists (left unchanged)');
  }

  if (!existsSync(mergePath)) {
    writeFileSync(mergePath, mergeWorkflowTemplate(branch), 'utf8');
    lines.push('trueline: wrote .github/workflows/trueline-merge.yml');
  } else {
    lines.push('trueline: .github/workflows/trueline-merge.yml already exists (left unchanged)');
  }

  lines.push('');
  lines.push('Add this section to trueline.json to lock allowlists to merge-time tightening:');
  lines.push(
    JSON.stringify(
      {
        github: {
          ratchet: 'merge',
          branch,
          protect: [
            '.github/workflows/trueline-verify.yml',
            '.github/workflows/trueline-merge.yml',
            '.github/CODEOWNERS',
          ],
        },
      },
      null,
      2,
    ),
  );

  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

export async function runGithubVerify(
  cwd: string,
  extraProtect: readonly string[],
): Promise<GithubCommandResult> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!token || !repo || !eventPath || !existsSync(eventPath)) {
    return {
      exitCode: 2,
      stdout: '',
      stderr:
        'trueline github verify: requires GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_EVENT_PATH (run inside GitHub Actions pull_request_target).\n',
    };
  }

  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as PullRequestEvent;
  const prNumber = event.pull_request?.number;
  const headSha = event.pull_request?.head?.sha;
  const author = event.pull_request?.user?.login;
  if (prNumber === undefined || headSha === undefined) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: 'trueline github verify: event payload does not contain a pull_request.\n',
    };
  }

  const { config: baseConfig } = loadConfig(cwd);
  const changedFiles = await fetchPullRequestFiles(repo, prNumber, token);
  const configChanges: {
    path: string;
    base: TruelineConfig;
    head: TruelineConfig | undefined;
  }[] = [];

  for (const file of changedFiles) {
    if (file === 'trueline.json' || file === '.trueline.json') {
      const basePath = join(cwd, file);
      const baseCfg = existsSync(basePath)
        ? loadConfig(cwd, basePath).config
        : baseConfig;
      const headText = await fetchFileAtRef(repo, file, headSha, token);
      const headCfg =
        headText !== undefined ? parseConfigText(headText, file) : undefined;
      configChanges.push({ path: file, base: baseCfg, head: headCfg });
    }
  }

  const protectedPaths = [
    ...(baseConfig.github?.protect ?? []),
    ...extraProtect,
  ];
  const violations = verifyPullRequestPolicy({
    changedFiles,
    author,
    botLogin: baseConfig.github?.bot,
    protectedPaths,
    configChanges,
  });

  if (violations.length === 0) {
    return {
      exitCode: 0,
      stdout: `trueline github verify: ok (${changedFiles.length} PR file(s) checked)\n`,
      stderr: '',
    };
  }

  const lines = [
    `trueline github verify: ${violations.length} governance violation(s):`,
    ...violations.map((v) => `  - ${v}`),
  ];
  return { exitCode: 1, stdout: '', stderr: `${lines.join('\n')}\n` };
}

export async function runGithubMerge(
  cwd: string,
  diagnostics: readonly Diagnostic[],
  options: { readonly allowPath: string; readonly branch: string },
): Promise<GithubCommandResult> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const absAllow = resolve(cwd, options.allowPath);

  const currentAllow = existsSync(absAllow)
    ? AllowList.parse(readFileSync(absAllow, 'utf8'))
    : new AllowList([]);
  const tightened = currentAllow.tighten(diagnostics);

  const prNumber =
    token && repo && sha
      ? await findMergedPullRequest(repo, sha, token)
      : undefined;

  if (tightened.unallowed.length > 0) {
    const summary = [
      `trueline merge check failed: **${tightened.unallowed.length}** unallowed architectural/hygiene finding(s) on \`${options.branch}\`:`,
      '',
      ...tightened.unallowed
        .slice(0, 15)
        .map((d) => `- \`${d.lint}\` \`${d.key}\`: ${d.message}`),
    ].join('\n');

    if (token && repo && prNumber !== undefined) {
      await postPullRequestComment(repo, prNumber, summary, token);
    }
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${summary}\n`,
    };
  }

  if (tightened.removed === 0 && tightened.shrunk === 0) {
    return {
      exitCode: 0,
      stdout: `trueline github merge: ok (${currentAllow.size()} allowlist entries unchanged)\n`,
      stderr: '',
    };
  }

  const nextText = tightened.next.toText('trueline');
  const note = `Tighten ${options.allowPath}: removed ${tightened.removed}, shrunk ${tightened.shrunk} (${tightened.next.size()} remaining)`;

  if (token && repo) {
    const relAllow = options.allowPath.replaceAll('\\', '/').replace(/^\.\//, '');
    await commitFileViaContentsApi(
      repo,
      relAllow,
      nextText,
      `chore(trueline): ${note}`,
      options.branch,
      token,
    );
    if (prNumber !== undefined) {
      const body = `**trueline ratchet tightened** on \`${options.branch}\`:\n- Removed: **${tightened.removed}** resolved entries\n- Shrunk: **${tightened.shrunk}** reduced cycles/tangles\n- Remaining in \`${relAllow}\`: **${tightened.next.size()}**`;
      await postPullRequestComment(repo, prNumber, body, token);
    }
  } else {
    mkdirSync(dirname(absAllow), { recursive: true });
    writeFileSync(absAllow, nextText, 'utf8');
  }

  return {
    exitCode: 0,
    stdout: `trueline github merge: ${note}\n`,
    stderr: '',
  };
}

async function githubFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'trueline',
      ...(init?.headers ?? {}),
    },
  });
}

async function fetchPullRequestFiles(
  repo: string,
  prNumber: number,
  token: string,
): Promise<string[]> {
  const files: string[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const res = await githubFetch(
      `https://api.github.com/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      token,
    );
    if (!res.ok) {
      throw new Error(`GitHub API pulls/files failed (${res.status})`);
    }
    const items = (await res.json()) as { filename: string }[];
    for (const item of items) files.push(item.filename);
    if (items.length < 100) break;
  }
  return files;
}

async function fetchFileAtRef(
  repo: string,
  path: string,
  ref: string,
  token: string,
): Promise<string | undefined> {
  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(ref)}`,
    token,
  );
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`GitHub API contents fetch for ${path} failed (${res.status})`);
  }
  const data = (await res.json()) as { content?: string; encoding?: string };
  if (typeof data.content !== 'string') return undefined;
  return Buffer.from(data.content.replace(/\s+/g, ''), 'base64').toString('utf8');
}

async function commitFileViaContentsApi(
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string,
  token: string,
): Promise<void> {
  const encodedPath = encodeRepoPath(path);
  const existingRes = await githubFetch(
    `https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    token,
  );
  let sha: string | undefined;
  if (existingRes.ok) {
    const existing = (await existingRes.json()) as { sha?: string };
    sha = existing.sha;
  }

  const putRes = await githubFetch(
    `https://api.github.com/repos/${repo}/contents/${encodedPath}`,
    token,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch,
        ...(sha !== undefined ? { sha } : {}),
      }),
    },
  );
  if (!putRes.ok) {
    throw new Error(`GitHub API contents PUT failed (${putRes.status}): ${await putRes.text()}`);
  }
}

function encodeRepoPath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

async function findMergedPullRequest(
  repo: string,
  sha: string,
  token: string,
): Promise<number | undefined> {
  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/commits/${sha}/pulls`,
    token,
  );
  if (!res.ok) return undefined;
  const pulls = (await res.json()) as { number?: number }[];
  return pulls[0]?.number;
}

async function postPullRequestComment(
  repo: string,
  prNumber: number,
  body: string,
  token: string,
): Promise<void> {
  await githubFetch(
    `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    },
  );
}
