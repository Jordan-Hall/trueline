/**
 * Optional Rust architectural analysis via upstream `deslop-please`.
 * Runtime-agnostic (Node 20+ & Bun).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, join, relative } from 'node:path';
import type { RustCrateReport } from '../model/types.ts';
import { toPosix } from './discover.ts';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  '.turbo',
  '.trueline-cache',
  'vendor',
  'sdk',
]);

function discoverRustRoots(rootDir: string): string[] {
  const cargoDirs: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Skip unreadable directories during Cargo workspace discovery.
      return;
    }

    const hasCargo = entries.some((e) => e.isFile() && e.name === 'Cargo.toml');
    if (hasCargo) {
      const rel = toPosix(relative(rootDir, dir));
      const text = safeRead(join(dir, 'Cargo.toml'));
      cargoDirs.push(rel);
      if (text !== undefined && /\[workspace\]/.test(text)) {
        return;
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };

  walk(rootDir, 0);
  cargoDirs.sort();

  const roots: string[] = [];
  for (const dir of cargoDirs) {
    const covered = roots.some(
      (parent) => parent.length > 0 && dir.startsWith(`${parent}/`),
    );
    if (!covered) roots.push(dir);
  }
  return roots;
}

export function analyzeRustCrates(rootDir: string): RustCrateReport[] {
  const roots = discoverRustRoots(rootDir);
  if (roots.length === 0) return [];

  const binary = resolveDeslopPleaseBinary();
  if (binary === undefined) {
    return roots.map((relDir) => ({
      name: shortCrateName(relDir),
      relDir,
      errorCount: 0,
      byLint: {},
      status: 'unavailable',
      note: 'deslop-please not found on PATH',
    }));
  }

  return roots.map((relDir) => runOnCrate(rootDir, relDir, binary));
}

function runOnCrate(
  rootDir: string,
  relDir: string,
  binary: string,
): RustCrateReport {
  const cwd = relDir.length === 0 ? rootDir : join(rootDir, relDir);
  const run = spawnSync(binary, [], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });

  const stdout = run.stdout ?? '';
  const stderr = run.stderr ?? '';

  if (run.status === 2 || run.error !== undefined) {
    const firstLine =
      stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? 'deslop-please failed';
    return {
      name: shortCrateName(relDir),
      relDir,
      errorCount: 0,
      byLint: {},
      status: 'unavailable',
      note: firstLine,
    };
  }

  const byLint: Record<string, number> = {};
  let total = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^error\[([a-z-]+)\]:/.exec(line);
    if (match !== null) {
      const lint = match[1]!;
      byLint[lint] = (byLint[lint] ?? 0) + 1;
      total += 1;
    }
  }

  return {
    name: shortCrateName(relDir),
    relDir,
    errorCount: total,
    byLint,
    status: total === 0 ? 'ok' : 'errors',
  };
}

function resolveDeslopPleaseBinary(): string | undefined {
  const pathEnv = process.env.PATH ?? '';
  const exeNames =
    process.platform === 'win32'
      ? ['deslop-please.exe', 'deslop-please']
      : ['deslop-please'];

  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const exe of exeNames) {
      const candidate = join(dir, exe);
      if (existsSync(candidate)) return candidate;
    }
  }

  const cargoHome = process.env.CARGO_HOME;
  const userProfile = process.env.USERPROFILE ?? process.env.HOME;
  for (const base of [
    cargoHome !== undefined ? join(cargoHome, 'bin') : undefined,
    userProfile !== undefined ? join(userProfile, '.cargo', 'bin') : undefined,
  ]) {
    if (base === undefined) continue;
    for (const exe of exeNames) {
      const candidate = join(base, exe);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function shortCrateName(relDir: string): string {
  if (relDir.length === 0) return 'root';
  const parts = relDir.split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  if (parts[0] === 'packages' || parts[0] === 'apps') {
    return parts.slice(1).join('/');
  }
  return parts.slice(-2).join('/');
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // Unreadable Cargo.toml skips workspace-member pruning.
    return undefined;
  }
}
