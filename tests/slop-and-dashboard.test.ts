import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCli } from '../src/cli/index.ts';

const tempDirs: string[] = [];

function createFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'trueline-slop-'));
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

describe('Code-hygiene & anti-slop lints + dashboard/HTML reporting', () => {
  test('catches verbose-comment, dead-code, silent-catch, and type-escape', () => {
    const dir = createFixture({
      'package.json': JSON.stringify({ name: 'sloppy-app', private: true }),
      'src/index.ts': `export { parseTimeout, trySafe } from './clean';\n`,
      'src/sloppy.ts': `
// ================================
// Helper function to process items
// Previously this used a map
export function processItem(raw: any): number {
  const coerced = raw as unknown as number;
  console.log('debug', coerced);
  // const old = 1;
  // const legacy = old + 2;
  // return legacy;
  try {
    return coerced + 1;
  } catch {
    return 0;
  }
}

export function silentEmpty(fn: () => void): void {
  try {
    fn();
  } catch {}
}

export function stubbed(): never {
  throw new Error('Not implemented yet');
}

// @ts-ignore
export const escaped = 42;
`,
      'src/clean.ts': `
/** Parses a positive integer timeout in milliseconds. */
export function parseTimeout(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError('Timeout must be a positive integer');
  }
  return parsed;
}

export function trySafe(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    // Expected when probe target is offline; caller handles false.
    return false;
  }
}
`,
    });

    const jsonRes = runCli(['--cwd', dir, '--format', 'json', '--no-cache']);
    expect(jsonRes.exitCode).toBe(1);
    const report = JSON.parse(jsonRes.stdout);
    const byLint = new Map<string, { key: string; notes: string[] }>();
    for (const d of report.diagnostics) {
      byLint.set(d.lint, d);
    }

    // Clean file must produce zero findings
    expect(
      report.diagnostics.some((d: { key: string }) => d.key.includes('clean.ts')),
    ).toBe(false);

    // All 4 anti-slop lints fire on sloppy.ts
    expect(byLint.get('verbose-comment')?.key).toBe('src/sloppy.ts');
    expect(byLint.get('verbose-comment')?.notes.some((n) => n.includes('banner-divider'))).toBe(true);
    expect(byLint.get('verbose-comment')?.notes.some((n) => n.includes('narration-comment'))).toBe(true);
    expect(byLint.get('verbose-comment')?.notes.some((n) => n.includes('history-comment'))).toBe(true);

    expect(byLint.get('dead-code')?.key).toBe('src/sloppy.ts');
    expect(byLint.get('dead-code')?.notes.some((n) => n.includes('commented-out-code'))).toBe(true);
    expect(byLint.get('dead-code')?.notes.some((n) => n.includes('debug-console'))).toBe(true);
    expect(byLint.get('dead-code')?.notes.some((n) => n.includes('unimplemented-stub'))).toBe(true);

    expect(byLint.get('silent-catch')?.key).toBe('src/sloppy.ts');
    expect(byLint.get('silent-catch')?.notes.some((n) => n.includes('empty-catch'))).toBe(true);

    expect(byLint.get('type-escape')?.key).toBe('src/sloppy.ts');
    expect(byLint.get('type-escape')?.notes.some((n) => n.includes('explicit-any'))).toBe(true);
    expect(byLint.get('type-escape')?.notes.some((n) => n.includes('double-assertion'))).toBe(true);
    expect(byLint.get('type-escape')?.notes.some((n) => n.includes('suppression-directive'))).toBe(true);

    // Dashboard CLI + simultaneous HTML output
    const htmlOut = join(dir, 'reports', 'health.html');
    const dashRes = runCli([
      '--cwd',
      dir,
      '--format',
      'dashboard',
      '--html',
      htmlOut,
    ]);
    expect(dashRes.exitCode).toBe(1);
    expect(dashRes.stdout).toContain('SLOPPY-APP');
    expect(dashRes.stdout).toContain('TypeScript Findings by Lint');
    expect(dashRes.stdout).toContain('Top Hotspot Packages & Apps');
    expect(dashRes.stdout).toContain('verbose-comment');

    expect(existsSync(htmlOut)).toBe(true);
    const html = readFileSync(htmlOut, 'utf8');
    expect(html).toContain('Architectural Health Report');
    expect(html).toContain('data-filter-lint="verbose-comment"');
    expect(html).toContain('id="trueline-data"');
  });
});
