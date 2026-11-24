/**
 * TypeScript Compiler API program factory with `tsconfig.json` `paths`/`baseUrl`
 * alias resolution and configurable custom-extension preprocessors.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import ts from 'typescript';
import type { PreprocessorRule, TruelineConfig } from '../model/types.ts';
import { stripJsonComments } from '../workspace/config.ts';
import { toPosix, type WorkspacePackage } from '../workspace/discover.ts';

const DEFAULT_RESOLVE_EXTS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const;

export interface PathAliasTable {
  readonly baseDir: string;
  readonly entries: readonly {
    readonly prefix: string;
    readonly suffix: string;
    readonly targets: readonly string[];
  }[];
}

export interface PackageProgram {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly rawLineCounts: ReadonlyMap<string, number>;
  readonly pathAliases: PathAliasTable | undefined;
}

function applyPreprocessor(
  source: string,
  rule: PreprocessorRule | undefined,
): string {
  if (rule === undefined) return source;
  let out = source;
  for (const [from, to] of rule.replace) {
    out = out.replaceAll(from, to);
  }
  return out;
}

export function createPackageProgram(
  rootDir: string,
  pkg: WorkspacePackage,
  config: TruelineConfig,
): PackageProgram {
  const absFiles = pkg.files.map((rel) => toPosix(resolve(rootDir, rel)));
  const absFileSet = new Set(absFiles);
  const rawLineCounts = new Map<string, number>();
  const resolveExts = [
    ...new Set([...DEFAULT_RESOLVE_EXTS, ...config.extensions]),
  ];
  const pathAliases = loadTsconfigPathAliases(pkg.tsconfigPath, rootDir);

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    noLib: true,
    types: [],
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    allowImportingTsExtensions: true,
    esModuleInterop: true,
    strict: false,
    noResolve: false,
  };

  const baseHost = ts.createCompilerHost(compilerOptions, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists(fileName: string): boolean {
      const norm = toPosix(resolve(fileName));
      if (absFileSet.has(norm)) return true;
      return baseHost.fileExists(fileName);
    },
    readFile(fileName: string): string | undefined {
      const norm = toPosix(resolve(fileName));
      if (!existsSync(fileName)) return baseHost.readFile(fileName);
      const raw = readFileSync(fileName, 'utf8');
      if (absFileSet.has(norm)) {
        rawLineCounts.set(norm, countLines(raw));
      }
      return applyPreprocessor(raw, config.preprocessors[extname(fileName)]);
    },
    getSourceFile(
      fileName: string,
      languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
      onError?: (message: string) => void,
      shouldCreateNewSourceFile?: boolean,
    ): ts.SourceFile | undefined {
      const norm = toPosix(resolve(fileName));
      if (absFileSet.has(norm) && existsSync(fileName)) {
        const raw = readFileSync(fileName, 'utf8');
        rawLineCounts.set(norm, countLines(raw));
        const ext = extname(fileName);
        const rule = config.preprocessors[ext];
        const text = applyPreprocessor(raw, rule);
        const kind = scriptKindFor(fileName, rule);
        return ts.createSourceFile(fileName, text, languageVersionOrOptions, true, kind);
      }
      return baseHost.getSourceFile(
        fileName,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile,
      );
    },
    resolveModuleNameLiterals(
      moduleLiterals: readonly ts.StringLiteralLike[],
      containingFile: string,
    ): readonly ts.ResolvedModuleWithFailedLookupLocations[] {
      return moduleLiterals.map((lit) => {
        const specifier = lit.text;
        const resolved = resolveModuleSpecifier(
          containingFile,
          specifier,
          pathAliases,
          resolveExts,
        );
        if (resolved !== undefined) {
          return {
            resolvedModule: {
              resolvedFileName: resolved,
              extension: tsExtensionFor(resolved, config.preprocessors[extname(resolved)]),
              isExternalLibraryImport: false,
            },
          };
        }
        return { resolvedModule: undefined };
      });
    },
  };

  const program = ts.createProgram(absFiles, compilerOptions, host);
  const checker = program.getTypeChecker();
  const sourceFiles: ts.SourceFile[] = [];
  for (const abs of absFiles) {
    const sf = program.getSourceFile(abs);
    if (sf !== undefined) sourceFiles.push(sf);
  }

  return { program, checker, sourceFiles, rawLineCounts, pathAliases };
}

export function resolveModuleSpecifier(
  fromFile: string,
  specifier: string,
  pathAliases: PathAliasTable | undefined,
  resolveExts: readonly string[] = DEFAULT_RESOLVE_EXTS,
): string | undefined {
  if (specifier.startsWith('.')) {
    return resolveCandidatePath(resolve(dirname(fromFile), specifier), resolveExts);
  }

  if (pathAliases !== undefined) {
    for (const entry of pathAliases.entries) {
      if (
        specifier.startsWith(entry.prefix) &&
        specifier.endsWith(entry.suffix) &&
        specifier.length >= entry.prefix.length + entry.suffix.length
      ) {
        const matched = specifier.slice(
          entry.prefix.length,
          specifier.length - entry.suffix.length,
        );
        for (const target of entry.targets) {
          const substituted = target.replace('*', matched);
          const candidate = resolve(pathAliases.baseDir, substituted);
          const hit = resolveCandidatePath(candidate, resolveExts);
          if (hit !== undefined) return hit;
        }
      }
    }
  }

  return undefined;
}

function resolveCandidatePath(
  rawTarget: string,
  resolveExts: readonly string[],
): string | undefined {
  if (existsSync(rawTarget) && extname(rawTarget).length > 0) {
    return toPosix(rawTarget);
  }

  const ext = extname(rawTarget);
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    const stem = rawTarget.slice(0, -ext.length);
    const candidates =
      ext === '.mjs'
        ? ['.mts', '.mjs']
        : ext === '.cjs'
          ? ['.cts', '.cjs']
          : ['.ts', '.tsx', '.js', '.jsx'];
    for (const candidateExt of candidates) {
      const candidate = `${stem}${candidateExt}`;
      if (existsSync(candidate)) return toPosix(candidate);
    }
  }

  for (const candidateExt of resolveExts) {
    const candidate = `${rawTarget}${candidateExt}`;
    if (existsSync(candidate)) return toPosix(candidate);
  }

  for (const candidateExt of resolveExts) {
    const candidate = join(rawTarget, `index${candidateExt}`);
    if (existsSync(candidate)) return toPosix(candidate);
  }

  return undefined;
}

/**
 * Loads `compilerOptions.paths` and `baseUrl` from a package's `tsconfig.json`
 * (falling back to workspace root `tsconfig.json` and following `extends`).
 */
function loadTsconfigPathAliases(
  pkgTsconfig: string | undefined,
  rootDir: string,
): PathAliasTable | undefined {
  const start =
    pkgTsconfig ??
    (existsSync(join(rootDir, 'tsconfig.json'))
      ? join(rootDir, 'tsconfig.json')
      : undefined);
  if (start === undefined) return undefined;

  const merged = readTsconfigChain(start, new Set());
  if (merged === undefined || merged.paths === undefined) return undefined;

  const baseDir =
    merged.baseUrl !== undefined
      ? resolve(merged.configDir, merged.baseUrl)
      : merged.configDir;

  const entries: {
    prefix: string;
    suffix: string;
    targets: readonly string[];
  }[] = [];

  for (const [pattern, targets] of Object.entries(merged.paths)) {
    if (!Array.isArray(targets)) continue;
    const star = pattern.indexOf('*');
    if (star === -1) {
      entries.push({ prefix: pattern, suffix: '', targets });
    } else {
      entries.push({
        prefix: pattern.slice(0, star),
        suffix: pattern.slice(star + 1),
        targets,
      });
    }
  }

  return entries.length > 0 ? { baseDir, entries } : undefined;
}

interface MergedTsconfig {
  readonly configDir: string;
  readonly baseUrl: string | undefined;
  readonly paths: Record<string, string[]> | undefined;
}

function readTsconfigChain(
  configPath: string,
  visited: Set<string>,
): MergedTsconfig | undefined {
  const norm = toPosix(resolve(configPath));
  if (visited.has(norm) || !existsSync(configPath)) return undefined;
  visited.add(norm);

  let parsed: {
    extends?: string;
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  };
  try {
    parsed = JSON.parse(
      stripJsonComments(readFileSync(configPath, 'utf8')),
    ) as typeof parsed;
  } catch {
    // Unparseable tsconfig skips path alias resolution cleanly.
    return undefined;
  }

  let parent: MergedTsconfig | undefined;
  if (typeof parsed.extends === 'string' && parsed.extends.startsWith('.')) {
    const rawExtends = resolve(dirname(configPath), parsed.extends);
    const parentPath = rawExtends.endsWith('.json')
      ? rawExtends
      : `${rawExtends}.json`;
    parent = readTsconfigChain(parentPath, visited);
  }

  const co = parsed.compilerOptions;
  const hasOwnPaths = co?.paths !== undefined;
  return {
    configDir: hasOwnPaths || co?.baseUrl !== undefined
      ? dirname(configPath)
      : (parent?.configDir ?? dirname(configPath)),
    baseUrl: co?.baseUrl ?? parent?.baseUrl,
    paths: co?.paths ?? parent?.paths,
  };
}

function scriptKindFor(
  fileName: string,
  rule: PreprocessorRule | undefined,
): ts.ScriptKind {
  if (rule?.scriptKind === 'tsx') return ts.ScriptKind.TSX;
  if (rule?.scriptKind === 'ts') return ts.ScriptKind.TS;
  if (rule?.scriptKind === 'jsx') return ts.ScriptKind.JSX;
  if (rule?.scriptKind === 'js') return ts.ScriptKind.JS;
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function tsExtensionFor(
  fileName: string,
  rule: PreprocessorRule | undefined,
): ts.Extension {
  if (rule?.scriptKind === 'tsx' || fileName.endsWith('.tsx')) return ts.Extension.Tsx;
  if (rule?.scriptKind === 'ts') return ts.Extension.Ts;
  if (rule?.scriptKind === 'jsx' || fileName.endsWith('.jsx')) return ts.Extension.Jsx;
  if (rule?.scriptKind === 'js' || fileName.endsWith('.js')) return ts.Extension.Js;
  if (fileName.endsWith('.mts')) return ts.Extension.Mts;
  if (fileName.endsWith('.cts')) return ts.Extension.Cts;
  if (fileName.endsWith('.mjs')) return ts.Extension.Mjs;
  if (fileName.endsWith('.cjs')) return ts.Extension.Cts;
  return ts.Extension.Ts;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return text.endsWith('\n') ? lines - 1 : lines;
}
