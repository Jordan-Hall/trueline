import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCli } from '../src/cli/index.ts';

const tempDirs: string[] = [];

function createFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'trueline-v1-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('trueline v1.0 lints, pnpm/tsconfig support, and CI reporting', () => {
  test('catches undeclared-dep, unused-export, wildcard-barrel, pass-through, complex-function, duplicate-logic, pnpm-workspace.yaml, and tsconfig paths', () => {
    const dir = createFixture({
      'package.json': JSON.stringify({ name: 'pnpm-repo', private: true }),
      'pnpm-workspace.yaml': `packages:\n  - 'packages/*'\n  - 'apps/*'\n`,
      'packages/core/package.json': JSON.stringify({ name: '@acme/core' }),
      'packages/core/tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['./src/*'] },
        },
      }),
      'packages/core/src/index.ts': `export * from './math';\n`,
      'packages/core/src/math.ts': `
        export function realWork(x: number): number {
          return x * 2 + 1;
        }
        export function wrapper(x: number): number {
          return realWork(x);
        }
        export function ghostHelper(): number {
          return 99;
        }
      `,
      'packages/core/src/alias-user.ts': `
        import { realWork } from '@/math';
        export function compute(a: number, b: number, c: number, d: number, e: number, f: number): number {
          if (a > 0) {
            for (let i = 0; i < b; i += 1) {
              if (c > 0) {
                if (d > 0) {
                  if (e > 0) {
                    return realWork(f);
                  }
                }
              }
            }
          }
          return 0;
        }
      `,
      'packages/core/src/clone-a.ts': `
        export function retryAlpha(items: number[], limit: number): number {
          let total = 0;
          for (let i = 0; i < items.length; i += 1) {
            const current = items[i] ?? 0;
            if (current > limit) {
              total += current * 2;
            } else if (current > 0) {
              total += current + 1;
            }
          }
          return total > 0 ? total : -1;
        }
      `,
      'packages/core/src/clone-b.ts': `
        export function retryBeta(values: number[], cap: number): number {
          let sum = 0;
          for (let j = 0; j < values.length; j += 1) {
            const val = values[j] ?? 0;
            if (val > cap) {
              sum += val * 2;
            } else if (val > 0) {
              sum += val + 1;
            }
          }
          return sum > 0 ? sum : -1;
        }
      `,
      // App imports @acme/core WITHOUT declaring it in package.json!
      'apps/web/package.json': JSON.stringify({ name: '@acme/web' }),
      'apps/web/src/index.ts': `
        import { realWork } from '@acme/core';
        export const out = realWork(5);
      `,
    });

    const jsonRes = runCli(['--cwd', dir, '--format', 'json', '--no-cache']);
    expect(jsonRes.exitCode).toBe(1);
    const report = JSON.parse(jsonRes.stdout);
    const lints = new Set(report.diagnostics.map((d: { lint: string }) => d.lint));

    expect(lints.has('undeclared-dep')).toBe(true);
    expect(lints.has('wildcard-barrel')).toBe(true);
    expect(lints.has('unused-export')).toBe(true);
    expect(lints.has('pass-through')).toBe(true);
    expect(lints.has('complex-function')).toBe(true);
    expect(lints.has('duplicate-logic')).toBe(true);

    // Presets filter cleanly
    const archOnly = runCli(['--cwd', dir, '--preset', 'arch', '--format', 'json']);
    const archLints = new Set(
      JSON.parse(archOnly.stdout).diagnostics.map((d: { lint: string }) => d.lint),
    );
    expect(archLints.has('undeclared-dep')).toBe(true);
    expect(archLints.has('complex-function')).toBe(false);

    const slopOnly = runCli(['--cwd', dir, '--preset', 'slop', '--format', 'json']);
    const slopLints = new Set(
      JSON.parse(slopOnly.stdout).diagnostics.map((d: { lint: string }) => d.lint),
    );
    expect(slopLints.has('duplicate-logic')).toBe(true);
    expect(slopLints.has('undeclared-dep')).toBe(false);

    // Baseline --compare, --format markdown, and --badge
    const baselinePath = join(dir, 'baseline.json');
    writeFileSync(
      baselinePath,
      JSON.stringify({ errorCount: report.errorCount + 3, byLint: { 'duplicate-logic': 4 } }),
      'utf8',
    );
    const badgePath = join(dir, 'badge.json');
    const mdRes = runCli([
      '--cwd',
      dir,
      '--format',
      'markdown',
      '--compare',
      baselinePath,
      '--badge',
      badgePath,
    ]);
    expect(mdRes.stdout).toContain('Architectural Health Report (`trueline`)');
    expect(mdRes.stdout).toContain('-3 vs baseline.json');
    expect(mdRes.stdout).toContain('| Lint | Count | Delta |');
    expect(existsSync(badgePath)).toBe(true);
    const badge = JSON.parse(readFileSync(badgePath, 'utf8'));
    expect(badge.label).toBe('trueline');
    expect(badge.schemaVersion).toBe(1);

    // --explain <lint>
    const explain = runCli(['--explain', 'duplicate-logic']);
    expect(explain.exitCode).toBe(0);
    expect(explain.stdout).toContain('trueline rule: duplicate-logic');
    expect(explain.stdout).toContain('Before:');
    expect(explain.stdout).toContain('After:');
  });
});
