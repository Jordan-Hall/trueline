/**
 * Configuration loader, preset resolver, and validator for `trueline.json` / `.trueline.json`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_LINTS,
  ARCH_LINTS,
  DEFAULT_CONFIG,
  isLintKind,
  SLOP_LINTS,
  type GithubGovernanceConfig,
  type LayerRule,
  type LintKind,
  type PreprocessorRule,
  type PresetKind,
  type TruelineConfig,
} from '../model/types.ts';

const DEFAULT_CONFIG_FILES = ['trueline.json', '.trueline.json'] as const;

function findConfigPath(rootDir: string): string | undefined {
  for (const name of DEFAULT_CONFIG_FILES) {
    const candidate = join(rootDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function parseConfigText(
  rawText: string,
  path: string,
): TruelineConfig {
  return mergeConfig(parseJsonc(rawText, path), path);
}

export function loadConfig(
  rootDir: string,
  explicitPath?: string,
): { readonly config: TruelineConfig; readonly configPath: string | undefined } {
  const path = explicitPath ?? findConfigPath(rootDir);
  if (path === undefined) {
    return { config: DEFAULT_CONFIG, configPath: undefined };
  }
  if (!existsSync(path)) {
    throw new Error(`Configuration file not found: ${path}`);
  }
  const rawText = readFileSync(path, 'utf8');
  return { config: parseConfigText(rawText, path), configPath: path };
}

export function applyPreset(
  config: TruelineConfig,
  preset: PresetKind | undefined,
): TruelineConfig {
  if (preset === undefined || preset === 'all') return config;

  if (preset === 'arch') {
    const lints = Object.fromEntries(
      ALL_LINTS.map((l) => [l, (ARCH_LINTS as readonly string[]).includes(l)]),
    ) as Record<LintKind, boolean>;
    return { ...config, lints };
  }

  if (preset === 'slop') {
    const lints = Object.fromEntries(
      ALL_LINTS.map((l) => [l, (SLOP_LINTS as readonly string[]).includes(l)]),
    ) as Record<LintKind, boolean>;
    return { ...config, lints };
  }

  // strict preset: tighter depth, size, and complexity budgets
  return {
    ...config,
    heldInMind: Math.min(config.heldInMind, 6),
    maxDirectoryMembers: Math.min(config.maxDirectoryMembers, 12),
    maxFileLines: Math.min(config.maxFileLines, 800),
    maxFunctionLines: Math.min(config.maxFunctionLines, 80),
    maxNestingDepth: Math.min(config.maxNestingDepth, 3),
    maxParameters: Math.min(config.maxParameters, 4),
  };
}

export function applyLintFilters(
  config: TruelineConfig,
  only?: readonly string[],
  skip?: readonly string[],
): TruelineConfig {
  const lints: Record<LintKind, boolean> = { ...config.lints };

  if (only !== undefined && only.length > 0) {
    for (const lint of ALL_LINTS) lints[lint] = false;
    for (const name of only) {
      if (!isLintKind(name)) {
        throw new Error(
          `Unknown lint "${name}" in --only (valid: ${ALL_LINTS.join(', ')})`,
        );
      }
      lints[name] = true;
    }
  }

  if (skip !== undefined && skip.length > 0) {
    for (const name of skip) {
      if (!isLintKind(name)) {
        throw new Error(
          `Unknown lint "${name}" in --skip (valid: ${ALL_LINTS.join(', ')})`,
        );
      }
      lints[name] = false;
    }
  }

  return { ...config, lints };
}

export function starterConfigJson(): string {
  return `${JSON.stringify(
    {
      heldInMind: 7,
      breakEven: 1,
      maxDirectoryMembers: 15,
      maxFileLines: 1500,
      maxFunctionLines: 120,
      maxNestingDepth: 4,
      maxParameters: 5,
      minCloneTokens: 45,
      ignoreTypeOnlyImports: false,
      layers: {
        preset: 'clean-architecture',
        noPackageToApp: true,
        featureSlices: [],
        rules: [
          {
            name: 'example-core-no-ui',
            from: 'packages/core/**',
            deny: ['packages/ui/**'],
            reason: 'Core domain packages must not depend on UI packages.',
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

export function agentsMdSnippet(): string {
  return [
    '- Run `trueline` to verify module depth, Clean Architecture boundaries, and code hygiene.',
    '- Fix issues flagged by `trueline` from first principles rather than hiding them behind wrappers or suppressions:',
    '  - `module-cycle`, `package-cycle`, `tangle`: move shared contracts down to the lower layer or extract a leaf module.',
    '  - `field-leak`, `shallow-module`, `pass-through`: keep invariants inside the owning module behind a narrow interface.',
    '  - `layer-violation`, `undeclared-dep`, `unused-export`, `wildcard-barrel`: enforce inward dependency flow and explicit public surfaces.',
    '  - `verbose-comment`, `dead-code`, `silent-catch`, `type-escape`, `complex-function`, `duplicate-logic`: keep code concise, explicit, and well-typed.',
  ].join('\n');
}

export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function parseJsonc(text: string, path: string): unknown {
  try {
    return JSON.parse(stripJsonComments(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${message}`);
  }
}

function mergeConfig(raw: unknown, path: string): TruelineConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path}: top-level value must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  const heldInMind = readPositiveInt(obj.heldInMind, DEFAULT_CONFIG.heldInMind, 'heldInMind', path);
  const breakEven = readNonNegativeInt(obj.breakEven, DEFAULT_CONFIG.breakEven, 'breakEven', path);
  const maxDirectoryMembers = readPositiveInt(
    obj.maxDirectoryMembers,
    DEFAULT_CONFIG.maxDirectoryMembers,
    'maxDirectoryMembers',
    path,
  );
  const maxFileLines = readPositiveInt(
    obj.maxFileLines,
    DEFAULT_CONFIG.maxFileLines,
    'maxFileLines',
    path,
  );
  const maxFunctionLines = readPositiveInt(
    obj.maxFunctionLines,
    DEFAULT_CONFIG.maxFunctionLines,
    'maxFunctionLines',
    path,
  );
  const maxNestingDepth = readPositiveInt(
    obj.maxNestingDepth,
    DEFAULT_CONFIG.maxNestingDepth,
    'maxNestingDepth',
    path,
  );
  const maxParameters = readPositiveInt(
    obj.maxParameters,
    DEFAULT_CONFIG.maxParameters,
    'maxParameters',
    path,
  );
  const minCloneTokens = readPositiveInt(
    obj.minCloneTokens,
    DEFAULT_CONFIG.minCloneTokens,
    'minCloneTokens',
    path,
  );
  const ignoreTypeOnlyImports =
    typeof obj.ignoreTypeOnlyImports === 'boolean'
      ? obj.ignoreTypeOnlyImports
      : DEFAULT_CONFIG.ignoreTypeOnlyImports;

  const ignore = Array.isArray(obj.ignore)
    ? [
        ...DEFAULT_CONFIG.ignore,
        ...obj.ignore.filter((x): x is string => typeof x === 'string'),
      ]
    : DEFAULT_CONFIG.ignore;

  const preprocessors = parsePreprocessors(obj.preprocessors, path);
  const extraExts = Object.keys(preprocessors);
  const extensions = Array.isArray(obj.extensions)
    ? obj.extensions.filter((x): x is string => typeof x === 'string')
    : [...new Set([...DEFAULT_CONFIG.extensions, ...extraExts])];

  const lints: Record<LintKind, boolean> = { ...DEFAULT_CONFIG.lints };
  if (obj.lints !== undefined && typeof obj.lints === 'object' && obj.lints !== null) {
    for (const [k, v] of Object.entries(obj.lints as Record<string, unknown>)) {
      if (!isLintKind(k)) {
        throw new Error(`${path}: unknown lint "${k}" in lints`);
      }
      if (typeof v !== 'boolean') {
        throw new Error(`${path}: lints.${k} must be a boolean`);
      }
      lints[k] = v;
    }
  }

  const rawLayers =
    obj.layers !== undefined && typeof obj.layers === 'object' && obj.layers !== null
      ? (obj.layers as Record<string, unknown>)
      : {};

  const preset =
    rawLayers.preset === 'none' || rawLayers.preset === 'clean-architecture'
      ? rawLayers.preset
      : DEFAULT_CONFIG.layers.preset;

  const noPackageToApp =
    typeof rawLayers.noPackageToApp === 'boolean'
      ? rawLayers.noPackageToApp
      : DEFAULT_CONFIG.layers.noPackageToApp;

  const featureSlices = Array.isArray(rawLayers.featureSlices)
    ? rawLayers.featureSlices.filter((x): x is string => typeof x === 'string')
    : DEFAULT_CONFIG.layers.featureSlices;

  const rules = Array.isArray(rawLayers.rules)
    ? rawLayers.rules.map((r, idx) => validateLayerRule(r, idx, path))
    : DEFAULT_CONFIG.layers.rules;

  const github = parseGithubConfig(obj.github, path);

  return {
    heldInMind,
    breakEven,
    maxDirectoryMembers,
    maxFileLines,
    maxFunctionLines,
    maxNestingDepth,
    maxParameters,
    minCloneTokens,
    ignoreTypeOnlyImports,
    ignore,
    extensions,
    preprocessors,
    lints,
    layers: {
      preset,
      noPackageToApp,
      featureSlices,
      rules,
    },
    github,
  };
}

function parseGithubConfig(
  raw: unknown,
  path: string,
): GithubGovernanceConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path}: github must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const ratchet =
    obj.ratchet === 'merge' || obj.ratchet === 'manual' ? obj.ratchet : 'merge';
  const branch =
    typeof obj.branch === 'string' && obj.branch.trim().length > 0
      ? obj.branch.trim()
      : 'main';
  const bot =
    typeof obj.bot === 'string' && obj.bot.trim().length > 0
      ? obj.bot.trim()
      : undefined;
  const protect = Array.isArray(obj.protect)
    ? obj.protect.filter((x): x is string => typeof x === 'string')
    : [
        '.github/workflows/trueline-verify.yml',
        '.github/workflows/trueline-merge.yml',
        '.github/CODEOWNERS',
      ];
  return { ratchet, branch, bot, protect };
}

function parsePreprocessors(
  raw: unknown,
  path: string,
): Record<string, PreprocessorRule> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path}: preprocessors must be an object keyed by extension`);
  }
  const out: Record<string, PreprocessorRule> = {};
  for (const [ext, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!ext.startsWith('.') || val === null || typeof val !== 'object') {
      throw new Error(`${path}: invalid preprocessor entry "${ext}"`);
    }
    const entry = val as Record<string, unknown>;
    const replace: [string, string][] = [];
    if (Array.isArray(entry.replace)) {
      for (const pair of entry.replace) {
        if (
          Array.isArray(pair) &&
          pair.length === 2 &&
          typeof pair[0] === 'string' &&
          typeof pair[1] === 'string'
        ) {
          replace.push([pair[0], pair[1]]);
        }
      }
    }
    const sk = entry.scriptKind;
    const scriptKind =
      sk === 'ts' || sk === 'tsx' || sk === 'js' || sk === 'jsx'
        ? sk
        : undefined;
    out[ext] = { replace, scriptKind };
  }
  return out;
}

function validateLayerRule(raw: unknown, index: number, path: string): LayerRule {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path}: layers.rules[${index}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
    throw new Error(`${path}: layers.rules[${index}].name must be a non-empty string`);
  }
  const from =
    typeof obj.from === 'string'
      ? obj.from
      : Array.isArray(obj.from) && obj.from.every((x) => typeof x === 'string')
        ? (obj.from as string[])
        : undefined;
  if (from === undefined) {
    throw new Error(`${path}: layers.rules[${index}].from must be a string or string[]`);
  }
  const deny = Array.isArray(obj.deny)
    ? obj.deny.filter((x): x is string => typeof x === 'string')
    : undefined;
  const allow = Array.isArray(obj.allow)
    ? obj.allow.filter((x): x is string => typeof x === 'string')
    : undefined;
  if ((deny === undefined || deny.length === 0) && (allow === undefined || allow.length === 0)) {
    throw new Error(`${path}: layers.rules[${index}] must define non-empty "deny" or "allow"`);
  }
  return {
    name: obj.name,
    from,
    deny,
    allow,
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
    ignoreTypeOnly:
      typeof obj.ignoreTypeOnly === 'boolean' ? obj.ignoreTypeOnly : undefined,
  };
}

function readPositiveInt(
  value: unknown,
  fallback: number,
  field: string,
  path: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path}: ${field} must be a positive integer`);
  }
  return value;
}

function readNonNegativeInt(
  value: unknown,
  fallback: number,
  field: string,
  path: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path}: ${field} must be a non-negative integer`);
  }
  return value;
}
