import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllowList } from '../src/allow/index.ts';
import { runCli, runCliAsync } from '../src/cli/index.ts';
import { detectConfigWeakening, verifyPullRequestPolicy } from '../src/github/policy.ts';
import { DEFAULT_CONFIG, type Diagnostic, type TruelineConfig } from '../src/model/types.ts';

function makeDiag(lint: Diagnostic['lint'], key: string): Diagnostic {
  return {
    lint,
    key,
    message: `${lint} at ${key}`,
    location: undefined,
    notes: [],
    picture: { kind: 'bar', label: lint, length: 1, most: 1 },
  };
}

function withTempRepo(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void> | void,
): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'trueline-gov-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  const done = () => rmSync(dir, { recursive: true, force: true });
  try {
    const res = fn(dir);
    if (res instanceof Promise) {
      return res.finally(done);
    }
    done();
    return;
  } catch (err) {
    done();
    throw err;
  }
}

describe('AllowList.tighten', () => {
  test('removes resolved entries, shrinks cycles, and never adds unallowed findings', () => {
    const allow = AllowList.fromDiagnostics([
      makeDiag('module-cycle', 'a,b,c'),
      makeDiag('long-file', 'src/big.ts'),
      makeDiag('silent-catch', 'src/a.ts:10'),
    ]);

    const tightened = allow.tighten([
      makeDiag('module-cycle', 'a,b'),
      makeDiag('silent-catch', 'src/a.ts:10'),
    ]);

    expect(tightened.unallowed).toHaveLength(0);
    expect(tightened.removed).toBe(1);
    expect(tightened.shrunk).toBe(1);
    expect(tightened.next.size()).toBe(2);
    expect(tightened.next.isAllowed(makeDiag('module-cycle', 'a,b'))).toBe(true);
    expect(tightened.next.isAllowed(makeDiag('module-cycle', 'a,b,c'))).toBe(false);
    expect(tightened.next.isAllowed(makeDiag('long-file', 'src/big.ts'))).toBe(false);
  });

  test('reports unallowed findings without silently ratcheting them in', () => {
    const allow = AllowList.fromDiagnostics([makeDiag('long-file', 'src/old.ts')]);
    const tightened = allow.tighten([
      makeDiag('long-file', 'src/old.ts'),
      makeDiag('type-escape', 'src/new.ts:4'),
    ]);
    expect(tightened.unallowed).toHaveLength(1);
    expect(tightened.unallowed[0]!.key).toBe('src/new.ts:4');
    expect(tightened.next.size()).toBe(1);
  });
});

describe('verifyPullRequestPolicy & detectConfigWeakening', () => {
  test('blocks PR edits to allowlists, protected workflows, and weakened configs', () => {
    const base: TruelineConfig = {
      ...DEFAULT_CONFIG,
      github: { ratchet: 'merge', branch: 'main', protect: ['.github/workflows/trueline-verify.yml'] },
      layers: {
        ...DEFAULT_CONFIG.layers,
        rules: [{ name: 'core-pure', from: ['src/core/**'], deny: ['src/ui/**'] }],
      },
    };
    const weakened: TruelineConfig = {
      ...base,
      maxFileLines: base.maxFileLines + 500,
      breakEven: 0,
      ignoreTypeOnlyImports: true,
      ignore: [...base.ignore, 'src/legacy/**'],
      lints: { ...base.lints, 'silent-catch': false },
      layers: { ...base.layers, preset: 'none', noPackageToApp: false, rules: [] },
      github: { ratchet: 'manual', branch: 'main', protect: [] },
    };

    const violations = verifyPullRequestPolicy({
      changedFiles: [
        '.trueline.allow',
        'packages/a/.trueline.allow',
        '.github/workflows/trueline-verify.yml',
        'trueline.json',
      ],
      author: 'contributor',
      botLogin: 'trueline-bot[bot]',
      protectedPaths: ['.github/workflows/trueline-verify.yml'],
      configChanges: [{ path: 'trueline.json', base, head: weakened }],
    });

    expect(violations.some((v) => v.includes('.trueline.allow'))).toBe(true);
    expect(violations.some((v) => v.includes('packages/a/.trueline.allow'))).toBe(true);
    expect(violations.some((v) => v.includes('trueline-verify.yml'))).toBe(true);
    expect(violations.some((v) => v.includes('github'))).toBe(true);
    expect(violations.some((v) => v.includes('silent-catch'))).toBe(true);
    expect(violations.some((v) => v.includes('maxFileLines'))).toBe(true);
    expect(violations.some((v) => v.includes('breakEven'))).toBe(true);
    expect(violations.some((v) => v.includes('ignoreTypeOnlyImports'))).toBe(true);
    expect(violations.some((v) => v.includes('src/legacy/**'))).toBe(true);
    expect(violations.some((v) => v.includes('clean-architecture'))).toBe(true);
    expect(violations.some((v) => v.includes('noPackageToApp'))).toBe(true);
    expect(violations.some((v) => v.includes('core-pure'))).toBe(true);
  });

  test('allows tightening thresholds, adding new layer rules, and configured bot commits', () => {
    const stricter: TruelineConfig = {
      ...DEFAULT_CONFIG,
      maxFileLines: 800,
      maxFunctionLines: 80,
      layers: {
        ...DEFAULT_CONFIG.layers,
        rules: [{ name: 'no-ui-in-core', from: ['src/core/**'], deny: ['src/ui/**'] }],
      },
    };
    expect(detectConfigWeakening(DEFAULT_CONFIG, stricter)).toEqual([]);

    const botViolations = verifyPullRequestPolicy({
      changedFiles: ['.trueline.allow'],
      author: 'trueline-bot[bot]',
      botLogin: 'trueline-bot[bot]',
      protectedPaths: ['.github/workflows/trueline-verify.yml'],
      configChanges: [],
    });
    expect(botViolations).toEqual([]);
  });
});

describe('trueline github CLI integration', () => {
  test('github init scaffolds both workflows and stays idempotent', async () => {
    await withTempRepo({ 'package.json': JSON.stringify({ name: 'demo' }) }, async (dir) => {
      const first = await runCliAsync(['github', 'init', '--cwd', dir, '--branch', 'main']);
      expect(first.exitCode).toBe(0);
      expect(existsSync(join(dir, '.github/workflows/trueline-verify.yml'))).toBe(true);
      expect(existsSync(join(dir, '.github/workflows/trueline-merge.yml'))).toBe(true);
      expect(readFileSync(join(dir, '.github/workflows/trueline-verify.yml'), 'utf8')).toContain(
        'pull_request_target',
      );
      expect(readFileSync(join(dir, '.github/workflows/trueline-merge.yml'), 'utf8')).toContain(
        "paths-ignore: ['**/.trueline.allow']",
      );

      const second = await runCliAsync(['github', 'init', '--cwd', dir]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain('already exists');
    });
  });

  test('--update-allow refuses when github.ratchet is merge unless --force is passed', () => {
    withTempRepo(
      {
        'package.json': JSON.stringify({ name: 'locked-pkg' }),
        'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext' } }),
        'trueline.json': JSON.stringify({
          github: { ratchet: 'merge', branch: 'main' },
        }),
        'src/index.ts': 'export const ok = 1;\n',
      },
      (dir) => {
        const refused = runCli(['--cwd', dir, '--no-cache', '--update-allow', '.trueline.allow']);
        expect(refused.exitCode).toBe(2);
        expect(refused.stderr).toContain('github.ratchet = "merge"');

        const forced = runCli([
          '--cwd',
          dir,
          '--no-cache',
          '--force',
          '--update-allow',
          '.trueline.allow',
        ]);
        expect(forced.exitCode).toBe(0);
        expect(existsSync(join(dir, '.trueline.allow'))).toBe(true);
      },
    );
  });

  test('github merge tightens allowlist locally when debt shrinks and rejects new violations', async () => {
    await withTempRepo(
      {
        'package.json': JSON.stringify({ name: 'ratchet-pkg' }),
        'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext' } }),
        '.trueline.allow': 'long-file src/deleted.ts\n',
        'src/index.ts': 'export const clean = 42;\n',
      },
      async (dir) => {
        const savedToken = process.env.GITHUB_TOKEN;
        const savedRepo = process.env.GITHUB_REPOSITORY;
        delete process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_REPOSITORY;
        try {
          const tightened = await runCliAsync([
            'github',
            'merge',
            '--cwd',
            dir,
            '--branch',
            'main',
            '--no-cache',
          ]);
          expect(tightened.exitCode).toBe(0);
          expect(tightened.stdout).toContain('removed 1');
          expect(readFileSync(join(dir, '.trueline.allow'), 'utf8')).not.toContain('src/deleted.ts');

          writeFileSync(join(dir, 'src/index.ts'), 'export const bad: any = 1;\n', 'utf8');
          const failed = await runCliAsync([
            'github',
            'merge',
            '--cwd',
            dir,
            '--branch',
            'main',
            '--no-cache',
          ]);
          expect(failed.exitCode).toBe(1);
          expect(failed.stderr).toContain('type-escape');
        } finally {
          if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
          if (savedRepo !== undefined) process.env.GITHUB_REPOSITORY = savedRepo;
        }
      },
    );
  });
});
