/**
 * Cache-aware workspace analyzer: analyzes each workspace package (with
 * content-hashed disk caching under `~/.cache/trueline/`), then merges all
 * package summaries into a single unified `Model`.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createEmptyModel,
  DEFAULT_CONFIG,
  type FileId,
  type ItemId,
  type Model,
  type NodeId,
  type TruelineConfig,
  type Wrapper,
} from '../model/types.ts';
import type { WorkspaceInfo, WorkspacePackage } from '../workspace/discover.ts';
import { extractPackageSummary, type PackageSummary } from './extract.ts';

const CACHE_SCHEMA_VERSION = 'v3';

export interface AnalyzeOptions {
  readonly useCache?: boolean;
  readonly config?: TruelineConfig;
  readonly onlyPackages?: ReadonlySet<string>;
}

export interface AnalyzeResult {
  readonly model: Model;
  readonly stats: {
    readonly packagesAnalyzed: number;
    readonly packagesFromCache: number;
    readonly files: number;
    readonly items: number;
    readonly references: number;
    readonly imports: number;
    readonly elapsedMs: number;
  };
}

export function analyzeWorkspace(
  workspace: WorkspaceInfo,
  options?: AnalyzeOptions,
): AnalyzeResult {
  const started = performance.now();
  const useCache = options?.useCache ?? true;
  const config = options?.config ?? DEFAULT_CONFIG;
  const cacheDir = join(
    homedir(),
    '.cache',
    'trueline',
    hashKey(workspace.rootDir),
  );

  let packagesAnalyzed = 0;
  let packagesFromCache = 0;
  const summaries: PackageSummary[] = [];

  for (const pkg of workspace.packages) {
    if (
      options?.onlyPackages !== undefined &&
      !options.onlyPackages.has(pkg.name)
    ) {
      continue;
    }
    const stamp = useCache
      ? computePackageStamp(workspace.rootDir, pkg, config)
      : undefined;
    const cacheFile =
      stamp !== undefined
        ? join(cacheDir, `${hashKey(pkg.relDir || pkg.name)}.json`)
        : undefined;

    let summary: PackageSummary | undefined;
    if (cacheFile !== undefined && stamp !== undefined && existsSync(cacheFile)) {
      summary = tryReadCache(cacheFile, stamp);
    }

    if (summary !== undefined) {
      packagesFromCache += 1;
    } else {
      summary = extractPackageSummary(workspace.rootDir, pkg, config);
      packagesAnalyzed += 1;
      if (cacheFile !== undefined && stamp !== undefined) {
        tryWriteCache(cacheDir, cacheFile, stamp, summary);
      }
    }
    summaries.push(summary);
  }

  const model = mergeSummaries(workspace, summaries);
  return {
    model,
    stats: {
      packagesAnalyzed,
      packagesFromCache,
      files: model.files.length,
      items: model.items.length,
      references: model.references.length,
      imports: model.imports.length,
      elapsedMs: Math.round(performance.now() - started),
    },
  };
}

function mergeSummaries(
  workspace: WorkspaceInfo,
  summaries: readonly PackageSummary[],
): Model {
  const model = createEmptyModel();
  const tree = model.tree;

  const pkgNodeByName = new Map<string, NodeId>();
  for (const pkg of workspace.packages) {
    const node = tree.child(tree.rootId, 'package', pkg.name, {
      dirPath: pkg.relDir,
      packageName: pkg.name,
      declaredDeps: pkg.workspaceDeps,
    });
    pkgNodeByName.set(pkg.name, node);
  }

  const fileIdByPath = new Map<string, FileId>();
  const globalExportsByPkg = new Map<string, Map<string, ItemId>>();
  const summaryMeta: {
    summary: PackageSummary;
    pkgNode: NodeId;
    fileIdMap: FileId[];
    itemIdMap: ItemId[];
  }[] = [];

  for (const summary of summaries) {
    const pkgNode =
      pkgNodeByName.get(summary.packageName) ??
      tree.child(tree.rootId, 'package', summary.packageName, {
        dirPath: summary.relDir,
        packageName: summary.packageName,
      });

    const fileIdMap: FileId[] = [];
    for (const file of summary.files) {
      let modNode = pkgNode;
      for (const seg of file.moduleSegments) {
        modNode = tree.child(modNode, 'module', seg);
      }
      const fileId = model.files.length;
      model.files.push({
        id: fileId,
        path: file.path,
        packageNode: pkgNode,
        moduleNode: modNode,
        isTest: file.isTest,
        isEntrypoint: file.isEntrypoint,
        lines: file.lines,
      });
      fileIdMap.push(fileId);
      fileIdByPath.set(file.path, fileId);
    }

    const baseItemId = model.items.length;
    const itemIdMap: ItemId[] = [];
    for (const item of summary.items) {
      const globalId = baseItemId + item.localId;
      itemIdMap.push(globalId);
      const fileId = fileIdMap[item.fileIndex]!;
      const fileInfo = model.files[fileId]!;
      model.items.push({
        id: globalId,
        name: item.name,
        owner: fileInfo.moduleNode,
        file: fileId,
        line: item.line,
        kind: item.kind,
        parent:
          item.parentLocalId !== undefined
            ? baseItemId + item.parentLocalId
            : undefined,
        exported: item.exported,
        takesSelf: item.takesSelf,
        isLifecycle: item.isLifecycle,
        holdsNothing: item.holdsNothing,
      });
    }

    for (const w of summary.wrappers) {
      const globalId = baseItemId + w.localId;
      const mapped: Wrapper =
        w.wrapper.kind === 'forwarder'
          ? {
              kind: 'forwarder',
              target: baseItemId + w.wrapper.target,
              fields: w.wrapper.fields.map((f) => baseItemId + f),
            }
          : {
              kind: 'accessor',
              lent: w.wrapper.lent.map((f) => baseItemId + f),
              copied: w.wrapper.copied.map((f) => baseItemId + f),
              toRead: w.wrapper.toRead,
            };
      model.wrappers.set(globalId, mapped);
    }

    for (const finding of summary.slopFindings ?? []) {
      const fileId = fileIdMap[finding.fileIndex];
      if (fileId === undefined) continue;
      model.slopFindings.push({
        lint: finding.lint,
        file: fileId,
        line: finding.line,
        column: finding.column,
        rule: finding.rule,
        detail: finding.detail,
        isTest: finding.isTest,
      });
    }

    for (const fn of summary.functions ?? []) {
      const fileId = fileIdMap[fn.fileIndex];
      if (fileId === undefined) continue;
      model.functions.push({
        file: fileId,
        line: fn.line,
        column: fn.column,
        name: fn.name,
        lines: fn.lines,
        maxNesting: fn.maxNesting,
        paramCount: fn.paramCount,
        tokenCount: fn.tokenCount,
        fingerprint: fn.fingerprint,
        isTest: fn.isTest,
      });
    }

    const expMap = new Map<string, ItemId>();
    for (const [expName, localId] of Object.entries(summary.exports)) {
      expMap.set(expName, baseItemId + localId);
    }
    globalExportsByPkg.set(summary.packageName, expMap);
    summaryMeta.push({ summary, pkgNode, fileIdMap, itemIdMap });
  }

  for (const { summary, pkgNode, fileIdMap, itemIdMap } of summaryMeta) {
    for (const ref of summary.references) {
      const fileId = fileIdMap[ref.fileIndex]!;
      const fileInfo = model.files[fileId]!;
      const targetId = itemIdMap[ref.targetLocalId];
      if (targetId === undefined) continue;
      model.references.push({
        file: fileId,
        line: ref.line,
        column: ref.column,
        from: fileInfo.moduleNode,
        holder:
          ref.holderLocalId !== undefined
            ? itemIdMap[ref.holderLocalId]
            : undefined,
        item: targetId,
        copies: ref.copies,
        typeOnly: ref.typeOnly,
        isTest: ref.isTest,
      });
    }

    for (const imp of summary.imports) {
      const fileId = fileIdMap[imp.fileIndex]!;
      const fileInfo = model.files[fileId]!;
      let targetFile: FileId | undefined;
      let targetModule: NodeId | undefined;
      let targetPackage: NodeId | undefined;
      let targetPkgName: string | undefined;

      if (imp.targetRelPath !== undefined) {
        targetFile = fileIdByPath.get(imp.targetRelPath);
        if (targetFile !== undefined) {
          const tf = model.files[targetFile]!;
          targetModule = tf.moduleNode;
          targetPackage = tf.packageNode;
          targetPkgName = tree.node(tf.packageNode).packageName;
        }
      } else {
        targetPkgName = matchWorkspaceSpecifier(
          imp.specifier,
          workspace.packageByName,
        );
        if (targetPkgName !== undefined) {
          targetPackage = pkgNodeByName.get(targetPkgName);
        }
      }

      model.imports.push({
        file: fileId,
        line: imp.line,
        column: imp.column,
        fromModule: fileInfo.moduleNode,
        fromPackage: pkgNode,
        specifier: imp.specifier,
        targetFile,
        targetModule,
        targetPackage,
        symbols: imp.symbols,
        typeOnly: imp.typeOnly,
        isWildcardReExport: imp.isWildcardReExport,
        isTest: imp.isTest,
      });

      if (
        targetPkgName !== undefined &&
        targetPackage !== undefined &&
        targetPackage !== pkgNode
      ) {
        linkCrossPackageRefs(
          model,
          globalExportsByPkg.get(targetPkgName),
          fileId,
          fileInfo.moduleNode,
          imp,
        );
      }
    }
  }

  return model;
}

function linkCrossPackageRefs(
  model: Model,
  expMap: ReadonlyMap<string, ItemId> | undefined,
  fileId: FileId,
  fromModule: NodeId,
  imp: {
    readonly line: number;
    readonly column: number;
    readonly symbols: readonly string[];
    readonly typeOnly: boolean;
    readonly isTest: boolean;
  },
): void {
  if (expMap === undefined) return;
  for (const sym of imp.symbols) {
    const targetItem = expMap.get(sym);
    if (targetItem === undefined) continue;
    model.references.push({
      file: fileId,
      line: imp.line,
      column: imp.column,
      from: fromModule,
      holder: undefined,
      item: targetItem,
      copies: true,
      typeOnly: imp.typeOnly,
      isTest: imp.isTest,
    });
  }
}

function matchWorkspaceSpecifier(
  specifier: string,
  packageByName: ReadonlyMap<string, WorkspacePackage>,
): string | undefined {
  if (specifier.startsWith('.')) return undefined;
  if (packageByName.has(specifier)) return specifier;
  const parts = specifier.split('/');
  if (specifier.startsWith('@') && parts.length >= 2) {
    const scoped = `${parts[0]}/${parts[1]}`;
    if (packageByName.has(scoped)) return scoped;
  } else if (parts.length >= 1) {
    const bare = parts[0]!;
    if (packageByName.has(bare)) return bare;
  }
  return undefined;
}

function computePackageStamp(
  rootDir: string,
  pkg: WorkspacePackage,
  config: TruelineConfig,
): string {
  const hasher = createHash('sha256');
  hasher.update(CACHE_SCHEMA_VERSION);
  hasher.update('\0');
  hasher.update(pkg.name);
  hasher.update('\0');
  hasher.update(JSON.stringify(config.preprocessors));
  hasher.update('\0');
  if (pkg.tsconfigPath !== undefined && existsSync(pkg.tsconfigPath)) {
    hasher.update(readFileSync(pkg.tsconfigPath));
  }
  for (const rel of pkg.files) {
    hasher.update('\0');
    hasher.update(rel);
    hasher.update('\0');
    const abs = resolve(rootDir, rel);
    if (existsSync(abs)) {
      hasher.update(readFileSync(abs));
    }
  }
  return hasher.digest('hex');
}

function hashKey(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function tryReadCache(
  cacheFile: string,
  expectedStamp: string,
): PackageSummary | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
      stamp?: string;
      summary?: PackageSummary;
    };
    if (parsed.stamp === expectedStamp && parsed.summary !== undefined) {
      return parsed.summary;
    }
  } catch {
    // Corrupted cache entry; fall back to fresh analysis.
  }
  return undefined;
}

function tryWriteCache(
  cacheDir: string,
  cacheFile: string,
  stamp: string,
  summary: PackageSummary,
): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ stamp, summary }));
  } catch {
    // Non-fatal if cache directory is not writable.
  }
}
