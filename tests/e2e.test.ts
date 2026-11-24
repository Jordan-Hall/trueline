import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCli } from '../src/cli/index.ts';

const tempDirs: string[] = [];

function createFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'trueline-e2e-'));
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
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('End-to-end TypeScript & Turborepo analysis', () => {
  test('catches real TS module-cycle, field-leak (direct & getter), shallow-module, and layer-violation', () => {
    const dir = createFixture({
      'package.json': JSON.stringify({
        name: 'fixture-monorepo',
        private: true,
        workspaces: ['packages/*', 'apps/*'],
      }),
      'turbo.json': JSON.stringify({ tasks: { build: {} } }),
      'trueline.json': JSON.stringify({
        heldInMind: 7,
        maxDirectoryMembers: 15,
        maxFileLines: 1500,
        preprocessors: {
          '.rx': { replace: [['@{', ' {']], scriptKind: 'tsx' },
        },
        layers: {
          preset: 'clean-architecture',
          noPackageToApp: true,
          featureSlices: ['apps/web/src/features/*'],
        },
      }),
      // Package 1: core (has module-cycle, field-leak, Clean Architecture violation, and shallow-module)
      'packages/core/package.json': JSON.stringify({ name: '@fixture/core' }),
      'packages/core/src/cycle/a.ts': `
        import { fromB } from './b';
        export function fromA(): number { return fromB() + 1; }
      `,
      'packages/core/src/cycle/b.ts': `
        import { fromA } from './a';
        export function fromB(): number { return fromA() + 1; }
      `,
      'packages/core/src/queue/ring.ts': `
        export class RunQueue {
          items: string[] = [];
          head = 0;
          private limit = 10;
          full(): boolean {
            return this.items.length - this.head >= this.limit;
          }
          getItems(): string[] {
            return this.items;
          }
        }
      `,
      'packages/core/src/sched/policy.ts': `
        import { RunQueue } from '../queue/ring';
        export function admit(q: RunQueue, task: string): number {
          q.items.push(task);
          q.getItems().push(task);
          return q.head;
        }
      `,
      'packages/core/src/domain/order.ts': `
        import { saveOrder } from '../infrastructure/repo';
        export function createOrder(id: string): void { saveOrder(id); }
      `,
      'packages/core/src/infrastructure/repo.ts': `
        export function saveOrder(_id: string): void {}
      `,
      // Shallow module: store/ has 8 shown methods and only 2 hidden
      'packages/core/src/store/index.ts': `
        export { Store } from './store';
      `,
      'packages/core/src/store/store.ts': `
        export class Store {
          m1() { return this.h1(); }
          m2() { return this.h2(); }
          m3() { return 3; }
          m4() { return 4; }
          m5() { return 5; }
          m6() { return 6; }
          m7() { return 7; }
          m8() { return 8; }
          private h1() { return 1; }
          private h2() { return 2; }
        }
      `,
      'packages/core/src/store/extra.ts': `export const STORE_VERSION = 1;`,
      'packages/core/src/app/consumer.ts': `
        import { Store } from '../store';
        export function useStore(s: Store) {
          return [s.m1(), s.m2(), s.m3(), s.m4(), s.m5(), s.m6(), s.m7(), s.m8()];
        }
      `,
      // App: web (has .tsrx file and feature-slice internal deep import)
      'apps/web/package.json': JSON.stringify({
        name: '@fixture/web',
        dependencies: { '@fixture/core': 'workspace:*' },
      }),
      'apps/web/src/features/auth/index.ts': `export { getToken } from './internal/token';`,
      'apps/web/src/features/auth/internal/token.ts': `export function getToken(): string { return 'tok'; }`,
      'apps/web/src/features/billing/pay.ts': `
        import { getToken } from '../auth/internal/token';
        export function pay(): string { return getToken(); }
      `,
      'apps/web/src/banner.rx': `
        import { pay } from './features/billing/pay';
        export default function Banner() @{
          <div>{pay()}</div>;
        }
      `,
    });

    const first = runCli(['--cwd', dir, '--format', 'json', '--stats']);
    expect(first.exitCode).toBe(1);
    const report = JSON.parse(first.stdout);
    const byLint = new Map<string, string[]>();
    for (const d of report.diagnostics) {
      const list = byLint.get(d.lint) ?? [];
      list.push(d.key);
      byLint.set(d.lint, list);
    }

    expect(byLint.get('module-cycle')).toEqual([
      '@fixture/core/cycle/a,@fixture/core/cycle/b',
    ]);
    expect(byLint.get('tangle')).toEqual([
      '@fixture/core/cycle/a:fromA,@fixture/core/cycle/b:fromB',
    ]);
    expect(byLint.get('field-leak')).toEqual([
      '@fixture/core/queue/ring:RunQueue.items',
    ]);
    expect(byLint.get('shallow-module')).toEqual(['@fixture/core/store']);
    expect(byLint.get('layer-violation')?.sort()).toEqual([
      'clean-architecture:@fixture/core:domain->infrastructure',
      'feature-slice:apps/web/src/features/billing->apps/web/src/features/auth:apps/web/src/features/auth/internal/token.ts',
    ]);

    // Second run hits the disk cache
    const second = runCli(['--cwd', dir, '--stats']);
    expect(second.stderr).toContain('2 cached');

    // Ratchet allowlist workflow: update-allow -> allow passes with exit 0
    const updated = runCli(['--cwd', dir, '--update-allow', '.trueline.allow']);
    expect(updated.exitCode).toBe(0);
    expect(existsSync(join(dir, '.trueline.allow'))).toBe(true);

    const ratcheted = runCli(['--cwd', dir, '--allow', '.trueline.allow']);
    expect(ratcheted.exitCode).toBe(0);
    expect(ratcheted.stdout).toContain('trueline: ok');

    // Per-package allowlist workflow
    const perPkgWrite = runCli([
      '--cwd',
      dir,
      '--per-package',
      '--update-allow',
      '.trueline.allow',
    ]);
    expect(perPkgWrite.exitCode).toBe(0);
    expect(existsSync(join(dir, 'packages/core/.trueline.allow'))).toBe(true);
    expect(existsSync(join(dir, 'apps/web/.trueline.allow'))).toBe(true);

    const perPkgCheck = runCli(['--cwd', dir, '--per-package']);
    expect(perPkgCheck.exitCode).toBe(0);
  });

  test('detects cross-package cycle and packages -> apps violation', () => {
    const dir = createFixture({
      'package.json': JSON.stringify({
        name: 'cycle-monorepo',
        private: true,
        workspaces: ['packages/*', 'apps/*'],
      }),
      'packages/alpha/package.json': JSON.stringify({ name: '@m/alpha' }),
      'packages/alpha/src/index.ts': `
        import { beta } from '@m/beta';
        import { appThing } from '@m/app';
        export function alpha() { return beta() + appThing(); }
      `,
      'packages/beta/package.json': JSON.stringify({ name: '@m/beta' }),
      'packages/beta/src/index.ts': `
        import { alpha } from '@m/alpha';
        export function beta() { return alpha(); }
      `,
      'apps/app/package.json': JSON.stringify({ name: '@m/app' }),
      'apps/app/src/index.ts': `export function appThing() { return 1; }`,
    });

    const res = runCli(['--cwd', dir, '--format', 'json']);
    expect(res.exitCode).toBe(1);
    const report = JSON.parse(res.stdout);
    const lints = report.diagnostics.map((d: { lint: string; key: string }) => `${d.lint}:${d.key}`);
    expect(lints).toContain('package-cycle:@m/alpha,@m/beta');
    expect(lints).toContain('layer-violation:no-package-to-app:@m/alpha->@m/app');
  });
});
