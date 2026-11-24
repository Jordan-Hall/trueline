/**
 * `layer-violation`: Clean Architecture & monorepo dependency direction rules.
 *
 * Enforces four deterministic architectural invariants over non-test imports:
 * 1. `noPackageToApp`: `packages/**` must never import `apps/**`.
 * 2. Clean Architecture preset (`preset: 'clean-architecture'`):
 *    inner rings (`domain`/`core`/`entities`) never depend on `application`
 *    or outer rings (`infrastructure`/`adapters`/`routes`/`http`/`ui`/`cli`),
 *    and `application` never depends on outer delivery/infrastructure rings.
 * 3. Custom declarative `rules` (`from` -> `deny` or `allow`).
 * 4. `featureSlices`: sibling feature slices may only import each other's
 *    public entrypoint (`index.*`), never deep internal modules.
 */

import type {
  Diagnostic,
  FileImport,
  LayerRule,
  Location,
  Model,
  NodeId,
  TruelineConfig,
} from '../model/types.ts';
import { clickable, counted, inScope, matchGlob } from './helpers.ts';

interface ViolationEdge {
  readonly site: Location;
  readonly detail: string;
}

interface ViolationGroup {
  readonly key: string;
  readonly ruleName: string;
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly reason: string | undefined;
  readonly edges: ViolationEdge[];
}

const INNER_LAYERS = new Set(['domain', 'entities', 'entity']);
const APPLICATION_LAYERS = new Set(['application', 'use-cases', 'usecases']);
const OUTER_LAYERS = new Set([
  'infrastructure',
  'infra',
  'adapters',
  'adapter',
  'presentation',
  'routes',
  'http',
  'controllers',
  'ui',
  'pages',
  'cli',
]);

export function checkLayers(
  model: Model,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const groups = new Map<string, ViolationGroup>();

  const record = (
    key: string,
    ruleName: string,
    fromLabel: string,
    toLabel: string,
    reason: string | undefined,
    edge: ViolationEdge,
  ): void => {
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, ruleName, fromLabel, toLabel, reason, edges: [] };
      groups.set(key, group);
    }
    group.edges.push(edge);
  };

  for (const imp of model.imports) {
    if (imp.isTest) continue;
    const fromFile = model.files[imp.file];
    if (fromFile === undefined) continue;
    if (!inScope(model.tree, scope, fromFile.moduleNode)) continue;

    const targetFile =
      imp.targetFile !== undefined ? model.files[imp.targetFile] : undefined;
    const targetPkgNode =
      imp.targetPackage !== undefined
        ? model.tree.node(imp.targetPackage)
        : undefined;
    const targetPath = targetFile?.path ?? targetPkgNode?.dirPath ?? imp.specifier;
    const targetPkgName = targetPkgNode?.packageName;
    const site: Location = {
      file: fromFile.path,
      line: imp.line,
      column: imp.column,
    };
    const detail = `imports \`${imp.specifier}\``;

    // 1. packages/* -> apps/* prohibition
    if (
      config.layers.noPackageToApp &&
      !(config.ignoreTypeOnlyImports && imp.typeOnly) &&
      fromFile.path.startsWith('packages/') &&
      (targetPath.startsWith('apps/') ||
        (targetPkgNode?.dirPath?.startsWith('apps/') ?? false))
    ) {
      const fromPkg = model.tree.node(imp.fromPackage).name;
      const toPkg = targetPkgNode?.name ?? targetPath;
      record(
        `no-package-to-app:${fromPkg}->${toPkg}`,
        'no-package-to-app',
        fromPkg,
        toPkg,
        'A reusable package must never depend on a deployable app.',
        { site, detail },
      );
    }

    // 2. Clean Architecture intra-package ring rules
    if (
      config.layers.preset === 'clean-architecture' &&
      !(config.ignoreTypeOnlyImports && imp.typeOnly) &&
      targetFile !== undefined &&
      imp.fromPackage === imp.targetPackage
    ) {
      const violation = detectCleanArchViolation(fromFile.path, targetFile.path);
      if (violation !== undefined) {
        const pkgName = model.tree.node(imp.fromPackage).name;
        record(
          `clean-architecture:${pkgName}:${violation.fromRing}->${violation.toRing}`,
          'clean-architecture',
          `${pkgName}/${violation.fromRing}`,
          `${pkgName}/${violation.toRing}`,
          violation.reason,
          { site, detail },
        );
      }
    }

    // 3. Custom declarative rules
    for (const rule of config.layers.rules) {
      const ignoreTypeOnly =
        rule.ignoreTypeOnly ?? config.ignoreTypeOnlyImports;
      if (ignoreTypeOnly && imp.typeOnly) continue;
      if (!matchesAny(rule.from, fromFile.path)) continue;

      const violated = isRuleViolated(rule, targetPath, targetPkgName, imp);
      if (!violated) continue;

      const fromLabel = Array.isArray(rule.from)
        ? rule.from.join('|')
        : String(rule.from);
      const toLabel = targetPkgName ?? targetPath;
      record(
        `${rule.name}:${fromFile.path}->${toLabel}`,
        rule.name,
        fromLabel,
        toLabel,
        rule.reason,
        { site, detail },
      );
    }

    // 4. Feature-slice encapsulation (siblings may only import slice entrypoint)
    if (
      config.layers.featureSlices.length > 0 &&
      !(config.ignoreTypeOnlyImports && imp.typeOnly) &&
      targetFile !== undefined
    ) {
      const sliceViolation = detectFeatureSliceViolation(
        config.layers.featureSlices,
        fromFile.path,
        targetFile.path,
      );
      if (sliceViolation !== undefined) {
        record(
          `feature-slice:${sliceViolation.fromSlice}->${sliceViolation.toSlice}:${targetFile.path}`,
          'feature-slice',
          sliceViolation.fromSlice,
          `${sliceViolation.toSlice} (internal)`,
          `Import \`${sliceViolation.toSlice}\` through its public index entrypoint instead of reaching into internals.`,
          { site, detail },
        );
      }
    }
  }

  const diagnostics: Diagnostic[] = [];
  for (const group of groups.values()) {
    group.edges.sort(
      (a, b) =>
        a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line,
    );
    const notes = group.edges
      .slice(0, config.heldInMind)
      .map((e) => `${clickable(e.site)}: ${e.detail}`);
    if (group.edges.length > config.heldInMind) {
      notes.push(
        `and ${counted(group.edges.length - config.heldInMind, 'more import')}`,
      );
    }
    if (group.reason !== undefined) {
      notes.push(group.reason);
    }
    diagnostics.push({
      lint: 'layer-violation',
      key: group.key,
      message: `\`${group.fromLabel}\` cannot depend on \`${group.toLabel}\` (${group.ruleName}): ${counted(group.edges.length, 'import')}`,
      location: group.edges[0]?.site,
      notes,
      picture: {
        kind: 'boundary',
        ruleName: group.ruleName,
        fromLabel: group.fromLabel,
        toLabel: group.toLabel,
        edges: group.edges,
        reason: group.reason,
      },
    });
  }

  return diagnostics;
}

function extractRing(path: string): { ring: 'inner' | 'application' | 'outer'; segment: string } | undefined {
  const segments = path.split('/');
  for (const segment of segments) {
    if (INNER_LAYERS.has(segment)) return { ring: 'inner', segment };
    if (APPLICATION_LAYERS.has(segment)) return { ring: 'application', segment };
    if (OUTER_LAYERS.has(segment)) return { ring: 'outer', segment };
  }
  return undefined;
}

function detectCleanArchViolation(
  fromPath: string,
  toPath: string,
): { fromRing: string; toRing: string; reason: string } | undefined {
  const from = extractRing(fromPath);
  const to = extractRing(toPath);
  if (from === undefined || to === undefined) return undefined;
  if (from.ring === 'inner' && to.ring !== 'inner') {
    return {
      fromRing: from.segment,
      toRing: to.segment,
      reason: `Inner domain layer \`${from.segment}\` must not depend on outer layer \`${to.segment}\`.`,
    };
  }
  if (from.ring === 'application' && to.ring === 'outer') {
    return {
      fromRing: from.segment,
      toRing: to.segment,
      reason: `Application layer \`${from.segment}\` must not depend on delivery/infrastructure layer \`${to.segment}\` (invert via a port/interface).`,
    };
  }
  return undefined;
}

function matchesAny(
  patterns: string | readonly string[],
  candidate: string,
): boolean {
  const list = typeof patterns === 'string' ? [patterns] : patterns;
  return list.some((p) => matchGlob(p, candidate));
}

function isRuleViolated(
  rule: LayerRule,
  targetPath: string,
  targetPkgName: string | undefined,
  imp: FileImport,
): boolean {
  const candidates = [targetPath, imp.specifier];
  if (targetPkgName !== undefined) candidates.push(targetPkgName);

  if (rule.deny !== undefined && rule.deny.length > 0) {
    return rule.deny.some((pattern) =>
      candidates.some((c) => matchGlob(pattern, c)),
    );
  }
  if (rule.allow !== undefined && rule.allow.length > 0) {
    // Only judge internal workspace/relative imports against allowlists.
    if (imp.targetFile === undefined && imp.targetPackage === undefined) {
      return false;
    }
    return !rule.allow.some((pattern) =>
      candidates.some((c) => matchGlob(pattern, c)),
    );
  }
  return false;
}

function detectFeatureSliceViolation(
  slicePatterns: readonly string[],
  fromPath: string,
  toPath: string,
): { fromSlice: string; toSlice: string } | undefined {
  for (const pattern of slicePatterns) {
    const fromSlice = sliceRootOf(pattern, fromPath);
    const toSlice = sliceRootOf(pattern, toPath);
    if (fromSlice === undefined || toSlice === undefined) continue;
    if (fromSlice === toSlice) continue;
    const remainder = toPath.slice(toSlice.length + 1);
    const isPublicEntry = /^index\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|tsrx)$/.test(
      remainder,
    );
    if (!isPublicEntry) {
      return { fromSlice, toSlice };
    }
  }
  return undefined;
}

/**
 * Given a slice pattern like `src/features/*` and path `src/features/billing/internal/calc.ts`,
 * returns `src/features/billing`.
 */
function sliceRootOf(pattern: string, filePath: string): string | undefined {
  const patternParts = pattern.replaceAll('\\', '/').split('/').filter(Boolean);
  const pathParts = filePath.replaceAll('\\', '/').split('/').filter(Boolean);
  if (pathParts.length <= patternParts.length) return undefined;

  for (let i = 0; i < patternParts.length; i += 1) {
    if (!matchGlob(patternParts[i]!, pathParts[i]!)) {
      return undefined;
    }
  }
  return pathParts.slice(0, patternParts.length).join('/');
}
