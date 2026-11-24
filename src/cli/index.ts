/**
 * Command-line interface for trueline.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { AllowList } from '../allow/index.ts';
import { analyzeWorkspace } from '../analyzer/index.ts';
import {
  renderBadgeJson,
  renderDiagnostics,
  type OutputFormat,
} from '../format/index.ts';
import {
  runGithubInit,
  runGithubMerge,
  runGithubVerify,
} from '../github/index.ts';
import { formatExplanation, resolveScope, runLints } from '../lint/index.ts';
import {
  ALL_LINTS,
  isLintKind,
  type BaselineSnapshot,
  type Diagnostic,
  type PresetKind,
  type ReportContext,
} from '../model/types.ts';
import {
  agentsMdSnippet,
  applyLintFilters,
  applyPreset,
  loadConfig,
  starterConfigJson,
} from '../workspace/config.ts';
import {
  discoverWorkspace,
  findAffectedPackages,
} from '../workspace/discover.ts';
import { analyzeRustCrates } from '../workspace/rust.ts';

const TOOL_NAME = 'trueline';
const TOOL_VERSION = readPackageVersion();

function readPackageVersion(): string {
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const pkgUrl = new URL(rel, import.meta.url);
      if (!existsSync(pkgUrl)) continue;
      const parsed = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version?: string };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // Fall back to default version when package.json cannot be read.
    }
  }
  return '1.0.0';
}

interface CliOptions {
  readonly scope: string | undefined;
  readonly cwd: string;
  readonly configPath: string | undefined;
  readonly allowPath: string | undefined;
  readonly updateAllowPath: string | undefined;
  readonly force: boolean;
  readonly perPackage: boolean;
  readonly localOnly: boolean;
  readonly affected: boolean;
  readonly affectedBase: string | undefined;
  readonly preset: PresetKind | undefined;
  readonly only: readonly string[] | undefined;
  readonly skip: readonly string[] | undefined;
  readonly ignoreTypeOnly: boolean;
  readonly format: OutputFormat;
  readonly outputPath: string | undefined;
  readonly htmlPath: string | undefined;
  readonly badgePath: string | undefined;
  readonly comparePath: string | undefined;
  readonly explainLint: string | undefined;
  readonly includeRust: boolean;
  readonly useCache: boolean;
  readonly stats: boolean;
  readonly init: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function usageText(): string {
  return [
    `usage: ${TOOL_NAME} [package_or_module] [options]`,
    `       ${TOOL_NAME} github <init|verify|merge> [options]`,
    '',
    'Deterministic architectural & code-hygiene linter for TypeScript and monorepos:',
    `  ${ALL_LINTS.join(', ')}`,
    '',
    'options:',
    '  <package_or_module>         Check one package or module (e.g. @org/pkg or packages/core)',
    '  --cwd <dir>                 Run against target workspace directory (default: .)',
    '  --config <path>             Path to trueline.json configuration',
    '  --preset <name>             Rule preset: all | arch | slop | strict (default: all)',
    '  --allow <path>              Suppress listed existing debt; new errors still fail',
    '  --update-allow <path>       Write current diagnostics to <path>',
    '  --force                     Allow --update-allow even when github.ratchet is "merge"',
    '  --per-package               Use per-package `.trueline.allow` files (ideal for Turborepo)',
    '  --local                     When scoping to a package, skip scanning its workspace dependents',
    '  --affected [baseRef]        Check only packages affected since git ref (+ dependents)',
    '  --only <lint1,lint2>        Run only the named lints',
    '  --skip <lint1,lint2>        Skip the named lints',
    '  --ignore-type-only          Ignore type-only imports/references in cycle & layer checks',
    '  --format <fmt>              Output: text | dashboard | html | markdown | json | sarif',
    '  -o, --output <path>         Write formatted output to a file instead of stdout',
    '  --html <path>               Also write a standalone HTML health dashboard to <path>',
    '  --badge <path>              Write a shields.io endpoint JSON badge to <path>',
    '  --compare <baseline.json>   Compare counts against a previous `--format json` report',
    '  --rust                      Also scan Cargo workspaces with `deslop-please` if present',
    '  --explain <lint>            Explain a rule with Before/After TypeScript examples',
    '  --no-cache                  Disable disk cache (~/.cache/trueline)',
    '  --stats                     Print workspace analysis timings and counts to stderr',
    '  --init                      Create starter trueline.json and print AGENTS.md snippet',
    '  -v, --version               Print version',
    '  -h, --help                  Show this help',
    '',
  ].join('\n');
}

function parseCliArgs(argv: readonly string[]): CliOptions {
  let scope: string | undefined;
  let cwd = process.cwd();
  let configPath: string | undefined;
  let allowPath: string | undefined;
  let updateAllowPath: string | undefined;
  let force = false;
  let perPackage = false;
  let localOnly = false;
  let affected = false;
  let affectedBase: string | undefined;
  let preset: PresetKind | undefined;
  let only: string[] | undefined;
  let skip: string[] | undefined;
  let ignoreTypeOnly = false;
  let format: OutputFormat = 'text';
  let outputPath: string | undefined;
  let htmlPath: string | undefined;
  let badgePath: string | undefined;
  let comparePath: string | undefined;
  let explainLint: string | undefined;
  let includeRust = false;
  let useCache = true;
  let stats = false;
  let init = false;
  let help = false;
  let version = false;

  const nextArg = (flag: string, i: number): string => {
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('-')) {
      throw new Error(`Option ${flag} requires a value`);
    }
    return val;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
      case 'help':
        help = true;
        break;
      case '-v':
      case '--version':
        version = true;
        break;
      case '--cwd':
        cwd = resolve(nextArg(arg, i));
        i += 1;
        break;
      case '--config':
        configPath = resolve(nextArg(arg, i));
        i += 1;
        break;
      case '--preset': {
        const val = nextArg(arg, i);
        if (val !== 'all' && val !== 'arch' && val !== 'slop' && val !== 'strict') {
          throw new Error(`Invalid --preset "${val}" (expected all, arch, slop, or strict)`);
        }
        preset = val;
        i += 1;
        break;
      }
      case '--allow':
        allowPath = nextArg(arg, i);
        i += 1;
        break;
      case '--update-allow':
        updateAllowPath = nextArg(arg, i);
        i += 1;
        break;
      case '--force':
        force = true;
        break;
      case '--per-package':
        perPackage = true;
        break;
      case '--local':
        localOnly = true;
        break;
      case '--affected': {
        affected = true;
        const maybeRef = argv[i + 1];
        if (maybeRef !== undefined && !maybeRef.startsWith('-')) {
          affectedBase = maybeRef;
          i += 1;
        }
        break;
      }
      case '--only':
        only = nextArg(arg, i)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        i += 1;
        break;
      case '--skip':
        skip = nextArg(arg, i)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        i += 1;
        break;
      case '--ignore-type-only':
        ignoreTypeOnly = true;
        break;
      case '--format': {
        const val = nextArg(arg, i);
        if (
          val !== 'text' &&
          val !== 'dashboard' &&
          val !== 'html' &&
          val !== 'markdown' &&
          val !== 'json' &&
          val !== 'sarif'
        ) {
          throw new Error(
            `Invalid --format "${val}" (expected text, dashboard, html, markdown, json, or sarif)`,
          );
        }
        format = val;
        i += 1;
        break;
      }
      case '-o':
      case '--output':
        outputPath = nextArg(arg, i);
        i += 1;
        break;
      case '--html':
        htmlPath = nextArg(arg, i);
        i += 1;
        break;
      case '--badge':
        badgePath = nextArg(arg, i);
        i += 1;
        break;
      case '--compare':
        comparePath = nextArg(arg, i);
        i += 1;
        break;
      case '--explain':
        explainLint = nextArg(arg, i);
        i += 1;
        break;
      case '--rust':
        includeRust = true;
        break;
      case '--no-cache':
        useCache = false;
        break;
      case '--stats':
        stats = true;
        break;
      case '--init':
        init = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        if (scope !== undefined) {
          throw new Error(`Unexpected extra positional argument: ${arg}`);
        }
        scope = arg;
        break;
    }
  }

  if (allowPath !== undefined && updateAllowPath !== undefined) {
    throw new Error('Cannot use --allow and --update-allow together');
  }

  return {
    scope,
    cwd,
    configPath,
    allowPath,
    updateAllowPath,
    force,
    perPackage,
    localOnly,
    affected,
    affectedBase,
    preset,
    only,
    skip,
    ignoreTypeOnly,
    format,
    outputPath,
    htmlPath,
    badgePath,
    comparePath,
    explainLint,
    includeRust,
    useCache,
    stats,
    init,
    help,
    version,
  };
}

export async function runCliAsync(
  argv: readonly string[],
  isTty = false,
): Promise<CliResult> {
  if (argv[0] === 'github') {
    try {
      return await runGithubSubcommand(argv.slice(1));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { exitCode: 2, stdout: '', stderr: `${TOOL_NAME}: ${msg}\n` };
    }
  }
  return runCli(argv, isTty);
}

export function runCli(argv: readonly string[], isTty = false): CliResult {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      stdout: '',
      stderr: `${TOOL_NAME}: ${msg}\n\n${usageText()}`,
    };
  }

  if (options.help) {
    return { exitCode: 0, stdout: usageText(), stderr: '' };
  }
  if (options.version) {
    return { exitCode: 0, stdout: `${TOOL_NAME} ${TOOL_VERSION}\n`, stderr: '' };
  }
  if (options.explainLint !== undefined) {
    if (!isLintKind(options.explainLint)) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: `${TOOL_NAME}: unknown lint "${options.explainLint}" (valid: ${ALL_LINTS.join(', ')})\n`,
      };
    }
    return { exitCode: 0, stdout: formatExplanation(options.explainLint), stderr: '' };
  }
  if (options.init) {
    return handleInit(options.cwd);
  }

  try {
    return executeCheck(options, isTty);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      stdout: '',
      stderr: `${TOOL_NAME}: ${msg}\n`,
    };
  }
}

function handleInit(cwd: string): CliResult {
  const target = join(cwd, 'trueline.json');
  const lines: string[] = [];
  if (existsSync(target)) {
    lines.push(`${TOOL_NAME}: ${target} already exists (left unchanged).`);
  } else {
    writeFileSync(target, starterConfigJson(), 'utf8');
    lines.push(`${TOOL_NAME}: wrote ${target}`);
  }
  lines.push('');
  lines.push('Suggested AGENTS.md snippet:');
  lines.push(agentsMdSnippet());
  lines.push('');
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

function executeCheck(options: CliOptions, isTty: boolean): CliResult {
  const stderrLines: string[] = [];
  const loaded = loadConfig(options.cwd, options.configPath);
  let config = applyPreset(loaded.config, options.preset);
  config = applyLintFilters(config, options.only, options.skip);
  if (options.ignoreTypeOnly) {
    config = { ...config, ignoreTypeOnlyImports: true };
  }

  const workspace = discoverWorkspace(options.cwd, config);

  let affectedNames: Set<string> | undefined;
  if (options.affected) {
    const affectedPkgs = findAffectedPackages(workspace, options.affectedBase);
    if (affectedPkgs.length === 0) {
      const rendered = renderDiagnostics([], options.format, {
        toolName: TOOL_NAME,
        color: shouldUseColor(isTty),
      });
      return {
        exitCode: 0,
        stdout: rendered,
        stderr: options.stats ? `${TOOL_NAME}: 0 affected packages\n` : '',
      };
    }
    affectedNames = new Set(affectedPkgs.map((p) => p.name));
  }

  const onlyPackages = selectPackagesToAnalyze(
    workspace,
    options.scope,
    affectedNames,
    options.localOnly,
  );

  const { model, stats } = analyzeWorkspace(workspace, {
    useCache: options.useCache,
    config,
    onlyPackages,
  });

  if (options.stats) {
    stderrLines.push(
      `${TOOL_NAME}: ${workspace.packages.length} package(s) (${stats.packagesAnalyzed} analyzed, ${stats.packagesFromCache} cached), ${stats.files} files, ${stats.items} items, ${stats.references} refs, ${stats.imports} imports in ${stats.elapsedMs}ms`,
    );
  }

  let diagnostics: Diagnostic[];
  if (options.scope !== undefined) {
    const scopeNode = resolveScope(model, options.scope);
    if (scopeNode === undefined) {
      throw new Error(`${options.scope}: no such package or module`);
    }
    diagnostics = runLints(model, config, scopeNode);
  } else if (affectedNames !== undefined) {
    const seen = new Map<string, Diagnostic>();
    for (const pkgName of affectedNames) {
      const node = resolveScope(model, pkgName);
      if (node === undefined) continue;
      for (const diag of runLints(model, config, node)) {
        seen.set(`${diag.lint}\0${diag.key}`, diag);
      }
    }
    diagnostics = [...seen.values()].sort(
      (a, b) => a.lint.localeCompare(b.lint) || a.key.localeCompare(b.key),
    );
  } else {
    diagnostics = runLints(model, config);
  }

  if (options.updateAllowPath !== undefined && config.github?.ratchet === 'merge' && !options.force) {
    return {
      exitCode: 2,
      stdout: '',
      stderr:
        `${TOOL_NAME}: --update-allow is locked because trueline.json sets github.ratchet = "merge".\n` +
        'Allowlists are tightened automatically on merge by the GitHub merge workflow.\n' +
        'Pass --force only when intentionally bootstrapping or overriding governance.\n',
    };
  }

  if (options.perPackage) {
    return handlePerPackageAllow(
      workspace,
      diagnostics,
      options,
      isTty,
      stderrLines,
    );
  }

  if (options.updateAllowPath !== undefined) {
    const absAllow = resolve(options.cwd, options.updateAllowPath);
    mkdirSync(dirname(absAllow), { recursive: true });
    const allow = AllowList.fromDiagnostics(diagnostics);
    writeFileSync(absAllow, allow.toText(TOOL_NAME), 'utf8');
    stderrLines.push(
      `${TOOL_NAME}: wrote ${allow.size()} entries to ${options.updateAllowPath}`,
    );
    return {
      exitCode: 0,
      stdout: '',
      stderr: stderrLines.length > 0 ? `${stderrLines.join('\n')}\n` : '',
    };
  }

  let reported = diagnostics;
  let fixedAllowed = 0;
  let allowShown: string | undefined;

  if (options.allowPath !== undefined) {
    const absAllow = resolve(options.cwd, options.allowPath);
    if (!existsSync(absAllow)) {
      throw new Error(`Allowlist file not found: ${options.allowPath}`);
    }
    const allow = AllowList.parse(readFileSync(absAllow, 'utf8'));
    fixedAllowed = allow.fixedCount(diagnostics);
    reported = diagnostics.filter((d) => !allow.isAllowed(d));
    allowShown = options.allowPath;
  }

  const baseline =
    options.comparePath !== undefined
      ? loadBaselineSnapshot(resolve(options.cwd, options.comparePath))
      : undefined;

  const rustCrates = options.includeRust
    ? analyzeRustCrates(workspace.rootDir)
    : [];

  const context: ReportContext = {
    projectName: deriveProjectName(workspace.rootDir),
    stats: { totalPackages: workspace.packages.length, ...stats },
    allowPath: allowShown,
    suppressedCount: diagnostics.length - reported.length,
    fixedAllowed,
    totalBeforeAllow: diagnostics.length,
    configuredFamilyRules: config.layers.rules.length,
    rustCrates,
    baseline,
    allDiagnostics:
      options.format === 'dashboard' ||
      options.format === 'html' ||
      options.format === 'markdown'
        ? diagnostics
        : undefined,
  };

  if (options.badgePath !== undefined) {
    const absBadge = resolve(options.cwd, options.badgePath);
    mkdirSync(dirname(absBadge), { recursive: true });
    writeFileSync(absBadge, renderBadgeJson(reported.length, TOOL_NAME), 'utf8');
    stderrLines.push(`${TOOL_NAME}: wrote badge JSON to ${options.badgePath}`);
  }

  if (options.htmlPath !== undefined) {
    const absHtml = resolve(options.cwd, options.htmlPath);
    mkdirSync(dirname(absHtml), { recursive: true });
    const htmlContent = renderDiagnostics(reported, 'html', {
      toolName: TOOL_NAME,
      fixedAllowed,
      allowPath: allowShown,
      context: { ...context, allDiagnostics: diagnostics },
    });
    writeFileSync(absHtml, htmlContent, 'utf8');
    stderrLines.push(`${TOOL_NAME}: wrote HTML report to ${options.htmlPath}`);
  }

  const rendered = renderDiagnostics(reported, options.format, {
    toolName: TOOL_NAME,
    color: options.outputPath === undefined && shouldUseColor(isTty),
    fixedAllowed,
    allowPath: allowShown,
    context,
  });

  if (options.outputPath !== undefined) {
    const absOut = resolve(options.cwd, options.outputPath);
    mkdirSync(dirname(absOut), { recursive: true });
    writeFileSync(absOut, rendered, 'utf8');
    stderrLines.push(`${TOOL_NAME}: wrote ${options.format} output to ${options.outputPath}`);
    return {
      exitCode: reported.length === 0 ? 0 : 1,
      stdout: '',
      stderr: stderrLines.length > 0 ? `${stderrLines.join('\n')}\n` : '',
    };
  }

  return {
    exitCode: reported.length === 0 ? 0 : 1,
    stdout: rendered,
    stderr: stderrLines.length > 0 ? `${stderrLines.join('\n')}\n` : '',
  };
}

function loadBaselineSnapshot(absPath: string): BaselineSnapshot {
  if (!existsSync(absPath)) {
    throw new Error(`Baseline file not found: ${absPath}`);
  }
  const parsed = JSON.parse(readFileSync(absPath, 'utf8')) as {
    errorCount?: number;
    byLint?: Record<string, number>;
    diagnostics?: { lint: string }[];
  };
  const byLint: Record<string, number> = {};
  if (parsed.byLint !== undefined) {
    Object.assign(byLint, parsed.byLint);
  } else if (Array.isArray(parsed.diagnostics)) {
    for (const d of parsed.diagnostics) {
      byLint[d.lint] = (byLint[d.lint] ?? 0) + 1;
    }
  }
  const total =
    typeof parsed.errorCount === 'number'
      ? parsed.errorCount
      : Object.values(byLint).reduce((a, b) => a + b, 0);

  return { label: basename(absPath), total, byLint };
}

function handlePerPackageAllow(
  workspace: ReturnType<typeof discoverWorkspace>,
  diagnostics: readonly Diagnostic[],
  options: CliOptions,
  isTty: boolean,
  stderrLines: string[],
): CliResult {
  const byPkg = new Map<string, Diagnostic[]>();
  for (const pkg of workspace.packages) {
    byPkg.set(pkg.relDir, []);
  }
  const byLongestDir = [...workspace.packages].sort(
    (a, b) => b.relDir.length - a.relDir.length,
  );

  const rootBucket: Diagnostic[] = [];
  for (const diag of diagnostics) {
    const file = diag.location?.file;
    let placed = false;
    if (file !== undefined) {
      for (const pkg of byLongestDir) {
        if (
          pkg.relDir.length === 0 ||
          file === pkg.relDir ||
          file.startsWith(`${pkg.relDir}/`)
        ) {
          byPkg.get(pkg.relDir)!.push(diag);
          placed = true;
          break;
        }
      }
    }
    if (!placed) rootBucket.push(diag);
  }

  if (options.updateAllowPath !== undefined) {
    let writtenFiles = 0;
    for (const [relDir, list] of byPkg) {
      const target =
        relDir.length === 0
          ? join(workspace.rootDir, '.trueline.allow')
          : join(workspace.rootDir, relDir, '.trueline.allow');
      if (list.length === 0 && !existsSync(target)) continue;
      writeFileSync(
        target,
        AllowList.fromDiagnostics(list).toText(TOOL_NAME),
        'utf8',
      );
      writtenFiles += 1;
    }
    stderrLines.push(
      `${TOOL_NAME}: updated ${writtenFiles} per-package .trueline.allow file(s)`,
    );
    return {
      exitCode: 0,
      stdout: '',
      stderr: `${stderrLines.join('\n')}\n`,
    };
  }

  const active: Diagnostic[] = [...rootBucket];
  let totalFixed = 0;
  for (const [relDir, list] of byPkg) {
    const allowFile =
      relDir.length === 0
        ? join(workspace.rootDir, '.trueline.allow')
        : join(workspace.rootDir, relDir, '.trueline.allow');
    if (existsSync(allowFile)) {
      const allow = AllowList.parse(readFileSync(allowFile, 'utf8'));
      totalFixed += allow.fixedCount(list);
      active.push(...list.filter((d) => !allow.isAllowed(d)));
    } else {
      active.push(...list);
    }
  }

  active.sort(
    (a, b) => a.lint.localeCompare(b.lint) || a.key.localeCompare(b.key),
  );
  const stdout = renderDiagnostics(active, options.format, {
    toolName: TOOL_NAME,
    color: shouldUseColor(isTty),
    fixedAllowed: totalFixed,
    allowPath: '.trueline.allow',
  });

  return {
    exitCode: active.length === 0 ? 0 : 1,
    stdout,
    stderr: stderrLines.length > 0 ? `${stderrLines.join('\n')}\n` : '',
  };
}

function selectPackagesToAnalyze(
  workspace: ReturnType<typeof discoverWorkspace>,
  scope: string | undefined,
  affectedNames: ReadonlySet<string> | undefined,
  localOnly: boolean,
): ReadonlySet<string> | undefined {
  if (!workspace.isMonorepo) return undefined;
  if (scope === undefined && affectedNames === undefined) return undefined;

  const targetNames = new Set<string>();
  if (affectedNames !== undefined) {
    for (const name of affectedNames) targetNames.add(name);
  }
  if (scope !== undefined) {
    const normalized = scope.replaceAll('\\', '/').replace(/\/+$/, '');
    const matched = workspace.packages.find(
      (p) =>
        p.name === normalized ||
        p.relDir === normalized ||
        normalized.startsWith(`${p.relDir}/`),
    );
    if (matched === undefined) return undefined;
    targetNames.add(matched.name);
  }

  if (localOnly) return targetNames;

  const selected = new Set(targetNames);
  for (const pkg of workspace.packages) {
    if (pkg.workspaceDeps.some((dep) => targetNames.has(dep))) {
      selected.add(pkg.name);
    }
  }
  return selected;
}

function deriveProjectName(rootDir: string): string {
  const pkgPath = join(rootDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
      if (typeof parsed.name === 'string' && parsed.name.length > 0) {
        return parsed.name;
      }
    } catch {
      // Fall back to directory basename if package.json is unreadable.
    }
  }
  const parts = rootDir.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'workspace';
}

function shouldUseColor(isTty: boolean): boolean {
  const truelineColor = process.env.TRUELINE_COLOR;
  if (truelineColor === 'always') return true;
  if (truelineColor === 'never') return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0') return true;
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  return isTty;
}

async function runGithubSubcommand(args: readonly string[]): Promise<CliResult> {
  const sub = args[0];
  if (sub === undefined || sub === '-h' || sub === '--help' || sub === 'help') {
    return {
      exitCode: 0,
      stdout: [
        `usage: ${TOOL_NAME} github <init|verify|merge> [options]`,
        '',
        'subcommands:',
        '  init   [--cwd <dir>] [--branch <name>]                     Write trueline-verify.yml and trueline-merge.yml',
        '  verify [--cwd <dir>] [--protect <path1,path2>]             Verify PR does not tamper with allowlist or config',
        '  merge  [--cwd <dir>] [--branch <name>] [--allow <path>]    Tighten allowlist on default branch after merge',
        '',
      ].join('\n'),
      stderr: '',
    };
  }

  let cwd = process.cwd();
  let branch: string | undefined;
  let allowPath = '.trueline.allow';
  let configPath: string | undefined;
  let useCache = true;
  const extraProtect: string[] = [];

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    const take = (): string => {
      const val = args[i + 1];
      if (val === undefined || val.startsWith('-')) {
        throw new Error(`Option ${arg} requires a value`);
      }
      i += 1;
      return val;
    };
    switch (arg) {
      case '--cwd':
        cwd = resolve(take());
        break;
      case '--branch':
        branch = take();
        break;
      case '--allow':
        allowPath = take();
        break;
      case '--config':
        configPath = resolve(take());
        break;
      case '--protect':
        for (const p of take().split(',').map((s) => s.trim()).filter(Boolean)) {
          extraProtect.push(p);
        }
        break;
      case '--no-cache':
        useCache = false;
        break;
      default:
        throw new Error(`Unknown option for github ${sub}: ${arg}`);
    }
  }

  if (sub === 'init') {
    return runGithubInit(cwd, branch ?? 'main');
  }
  if (sub === 'verify') {
    return runGithubVerify(cwd, extraProtect);
  }
  if (sub === 'merge') {
    const loaded = loadConfig(cwd, configPath);
    const workspace = discoverWorkspace(cwd, loaded.config);
    const { model } = analyzeWorkspace(workspace, { useCache, config: loaded.config });
    const diagnostics = runLints(model, loaded.config);
    const targetBranch = branch ?? loaded.config.github?.branch ?? 'main';
    return runGithubMerge(cwd, diagnostics, { allowPath, branch: targetBranch });
  }
  throw new Error(`Unknown github subcommand "${sub}" (expected init, verify, or merge)`);
}
