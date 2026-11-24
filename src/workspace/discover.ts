/**
 * Runtime-agnostic (Node 20+ & Bun) workspace discovery for npm, yarn, bun,
 * pnpm (`pnpm-workspace.yaml`), and Turborepo repositories, plus `--affected`
 * git change closure.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { matchGlob } from '../model/glob.ts';
import type { TruelineConfig } from '../model/types.ts';

export interface WorkspacePackage {
  readonly name: string;
  readonly relDir: string;
  readonly absDir: string;
  readonly files: readonly string[];
  readonly entrypoints: ReadonlySet<string>;
  readonly workspaceDeps: readonly string[];
  readonly tsconfigPath: string | undefined;
}

export interface WorkspaceInfo {
  readonly rootDir: string;
  readonly isMonorepo: boolean;
  readonly hasTurbo: boolean;
  readonly packages: readonly WorkspacePackage[];
  readonly packageByName: ReadonlyMap<string, WorkspacePackage>;
}

interface PackageJsonShape {
  name?: string;
  main?: string;
  module?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const HARD_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  '.next',
  '.rslib',
  '.rspress',
  '.trueline-cache',
  'dist',
  'dist-server',
  'build',
  'target',
  'coverage',
  '.vscode',
]);

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function discoverWorkspace(
  rootDir: string,
  config: TruelineConfig,
): WorkspaceInfo {
  const absRoot = resolve(rootDir);
  const rootPkgPath = join(absRoot, 'package.json');
  const rootManifest = existsSync(rootPkgPath)
    ? safeReadJson<PackageJsonShape>(rootPkgPath)
    : undefined;
  const hasTurbo = existsSync(join(absRoot, 'turbo.json'));

  const pkgPatterns = extractWorkspacePatterns(rootManifest);
  const pnpmPatterns = readPnpmWorkspacePatterns(absRoot);
  const workspacePatterns =
    pkgPatterns.length > 0 ? pkgPatterns : pnpmPatterns;

  const isMonorepo = workspacePatterns.length > 0;
  const memberRelDirs = isMonorepo
    ? expandWorkspaceDirectories(absRoot, workspacePatterns)
    : [''];

  const effectiveDirs = memberRelDirs.length > 0 ? memberRelDirs : [''];
  const memberSet = new Set(effectiveDirs);
  const rawManifests = new Map<string, PackageJsonShape>();
  const allNames = new Set<string>();

  for (const relDir of effectiveDirs) {
    const absDir = relDir.length === 0 ? absRoot : join(absRoot, relDir);
    const manifest = safeReadJson<PackageJsonShape>(join(absDir, 'package.json')) ?? {};
    rawManifests.set(relDir, manifest);
    const pkgName = manifest.name ?? (relDir.length === 0 ? basenameOrRoot(absRoot) : relDir);
    allNames.add(pkgName);
  }

  const extSet = new Set(config.extensions);
  const packages: WorkspacePackage[] = [];
  const packageByName = new Map<string, WorkspacePackage>();

  for (const relDir of effectiveDirs) {
    const absDir = relDir.length === 0 ? absRoot : join(absRoot, relDir);
    const manifest = rawManifests.get(relDir) ?? {};
    const name =
      manifest.name ?? (relDir.length === 0 ? basenameOrRoot(absRoot) : relDir);

    const allDeps = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);
    const workspaceDeps = [...allDeps]
      .filter((dep) => dep !== name && allNames.has(dep))
      .sort();

    const files = collectPackageFiles(
      absRoot,
      absDir,
      relDir,
      memberSet,
      extSet,
      config.ignore,
    );
    const entrypoints = detectEntrypoints(relDir, manifest, files);

    const tsconfigCandidate = join(absDir, 'tsconfig.json');
    const pkg: WorkspacePackage = {
      name,
      relDir,
      absDir,
      files,
      entrypoints,
      workspaceDeps,
      tsconfigPath: existsSync(tsconfigCandidate) ? tsconfigCandidate : undefined,
    };
    packages.push(pkg);
    packageByName.set(name, pkg);
  }

  return {
    rootDir: absRoot,
    isMonorepo: isMonorepo && effectiveDirs.length > 1,
    hasTurbo,
    packages,
    packageByName,
  };
}

export function findAffectedPackages(
  workspace: WorkspaceInfo,
  baseRef?: string,
): WorkspacePackage[] {
  const ref = baseRef ?? detectDefaultBaseRef(workspace.rootDir);
  const changedFiles = new Set<string>();

  if (ref !== undefined) {
    const diff = runGit(workspace.rootDir, ['diff', '--name-only', `${ref}...HEAD`]);
    if (diff !== undefined) {
      for (const line of diff.split(/\r?\n/)) {
        if (line.trim().length > 0) changedFiles.add(line.trim());
      }
    }
  }

  const status = runGit(workspace.rootDir, ['status', '--porcelain']);
  if (status !== undefined) {
    for (const line of status.split(/\r?\n/)) {
      if (line.length < 4) continue;
      const entry = line.slice(3).trim();
      const arrow = entry.indexOf(' -> ');
      changedFiles.add(arrow === -1 ? entry : entry.slice(arrow + 4));
    }
  }

  if (changedFiles.size === 0) return [];

  for (const file of changedFiles) {
    if (
      file === 'package.json' ||
      file === 'pnpm-workspace.yaml' ||
      file === 'turbo.json' ||
      file === 'trueline.json' ||
      file === '.trueline.json'
    ) {
      return [...workspace.packages];
    }
  }

  const byLongestDir = [...workspace.packages].sort(
    (a, b) => b.relDir.length - a.relDir.length,
  );
  const affected = new Set<string>();
  for (const file of changedFiles) {
    const norm = file.replaceAll('\\', '/');
    for (const pkg of byLongestDir) {
      if (
        pkg.relDir.length === 0 ||
        norm === pkg.relDir ||
        norm.startsWith(`${pkg.relDir}/`)
      ) {
        affected.add(pkg.name);
        break;
      }
    }
  }

  const reverseDeps = new Map<string, string[]>();
  for (const pkg of workspace.packages) {
    for (const dep of pkg.workspaceDeps) {
      let list = reverseDeps.get(dep);
      if (list === undefined) {
        list = [];
        reverseDeps.set(dep, list);
      }
      list.push(pkg.name);
    }
  }

  const queue = [...affected];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependent of reverseDeps.get(current) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }

  return workspace.packages.filter((pkg) => affected.has(pkg.name));
}

/**
 * Parses the `packages:` list from `pnpm-workspace.yaml` with zero YAML dependencies.
 */
function readPnpmWorkspacePatterns(rootDir: string): string[] {
  const yamlPath = join(rootDir, 'pnpm-workspace.yaml');
  if (!existsSync(yamlPath)) return [];
  let text: string;
  try {
    text = readFileSync(yamlPath, 'utf8');
  } catch {
    // Unreadable pnpm-workspace.yaml falls back to single-package discovery.
    return [];
  }

  const patterns: string[] = [];
  let inPackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const noComment = rawLine.replace(/#.*$/, '');
    const trimmed = noComment.trim();
    if (trimmed.length === 0) continue;

    if (/^packages\s*:/.test(trimmed)) {
      inPackages = true;
      continue;
    }
    if (inPackages && !rawLine.startsWith(' ') && !rawLine.startsWith('\t') && !trimmed.startsWith('-')) {
      inPackages = false;
      continue;
    }
    if (inPackages && trimmed.startsWith('-')) {
      const val = trimmed
        .slice(1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      if (val.length > 0) patterns.push(val);
    }
  }
  return patterns;
}

function detectEntrypoints(
  relDir: string,
  manifest: PackageJsonShape,
  files: readonly string[],
): Set<string> {
  const entries = new Set<string>();
  const prefix = relDir.length > 0 ? `${relDir}/` : '';

  const markIfExists = (rawTarget: string): void => {
    const cleaned = rawTarget.replace(/^\.\//, '');
    const full = `${prefix}${cleaned}`;
    if (files.includes(full)) entries.add(full);
    // Map dist/foo.js -> src/foo.ts for built libraries
    if (cleaned.startsWith('dist/')) {
      const stem = cleaned
        .slice('dist/'.length)
        .replace(/\.(?:js|mjs|cjs|d\.ts)$/, '');
      for (const ext of ['.ts', '.tsx', '.mts', '.js']) {
        const candidate = `${prefix}src/${stem}${ext}`;
        if (files.includes(candidate)) entries.add(candidate);
      }
    }
  };

  if (typeof manifest.main === 'string') markIfExists(manifest.main);
  if (typeof manifest.module === 'string') markIfExists(manifest.module);
  if (typeof manifest.bin === 'string') markIfExists(manifest.bin);
  else if (manifest.bin !== undefined && typeof manifest.bin === 'object') {
    for (const v of Object.values(manifest.bin)) {
      if (typeof v === 'string') markIfExists(v);
    }
  }

  const collectExportStrings = (node: unknown): void => {
    if (typeof node === 'string') {
      markIfExists(node);
    } else if (node !== null && typeof node === 'object') {
      for (const v of Object.values(node as Record<string, unknown>)) {
        collectExportStrings(v);
      }
    }
  };
  collectExportStrings(manifest.exports);

  // Conventional root entrypoints (`src/index.ts`, `index.ts`, `src/main.ts`, `src/cli/bin.ts`)
  for (const file of files) {
    const inside = relDir.length > 0 && file.startsWith(prefix)
      ? file.slice(prefix.length)
      : file;
    if (
      /^(?:src\/)?(?:index|main|app|server|cli\/bin|bin)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(
        inside,
      )
    ) {
      entries.add(file);
    }
  }

  return entries;
}

function detectDefaultBaseRef(cwd: string): string | undefined {
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master', 'HEAD~1']) {
    if (runGit(cwd, ['rev-parse', '--verify', candidate]) !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function runGit(cwd: string, args: readonly string[]): string | undefined {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return res.status === 0 ? res.stdout : undefined;
}

function extractWorkspacePatterns(manifest: PackageJsonShape | undefined): string[] {
  if (manifest?.workspaces === undefined) return [];
  if (Array.isArray(manifest.workspaces)) {
    return manifest.workspaces.filter((p) => typeof p === 'string');
  }
  if (Array.isArray(manifest.workspaces.packages)) {
    return manifest.workspaces.packages.filter((p) => typeof p === 'string');
  }
  return [];
}

function expandWorkspaceDirectories(rootDir: string, patterns: readonly string[]): string[] {
  const positive = patterns
    .filter((p) => !p.startsWith('!'))
    .map((p) => p.replace(/\/+$/, ''));
  const negative = patterns
    .filter((p) => p.startsWith('!'))
    .map((p) => p.slice(1).replace(/\/+$/, ''));

  const found = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Skip unreadable directories during workspace discovery.
      return;
    }

    const rel = toPosix(relative(rootDir, dir));
    if (
      rel.length > 0 &&
      entries.some((e) => e.isFile() && e.name === 'package.json')
    ) {
      const included = positive.some((pat) => matchGlob(pat, rel));
      const excluded = negative.some((pat) => matchGlob(pat, rel));
      if (included && !excluded) found.add(rel);
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || HARD_SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };

  walk(rootDir, 0);
  return [...found].sort();
}

function collectPackageFiles(
  absRoot: string,
  absDir: string,
  ownerRelDir: string,
  allMembers: ReadonlySet<string>,
  extSet: ReadonlySet<string>,
  ignorePatterns: readonly string[],
): string[] {
  const out: string[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Skip unreadable or concurrently removed directories during discovery.
      return;
    }

    for (const entry of entries) {
      if (HARD_SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = toPosix(relative(absRoot, full));

      if (entry.isDirectory()) {
        if (rel !== ownerRelDir && allMembers.has(rel)) continue;
        if (
          rel !== ownerRelDir &&
          existsSync(join(full, 'package.json')) &&
          allMembers.size > 1
        ) {
          continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (!extSet.has(ext)) continue;
        if (ignorePatterns.some((pat) => matchGlob(pat, rel))) continue;
        out.push(rel);
      }
    }
  };

  walk(absDir);
  out.sort();
  return out;
}

function safeReadJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    // Optional or malformed package.json is handled by caller fallbacks.
    return undefined;
  }
}

function basenameOrRoot(absPath: string): string {
  const parts = toPosix(absPath).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'root';
}
