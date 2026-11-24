/**
 * Pure report aggregation shared by the CLI dashboard and standalone HTML report.
 */

import {
  ALL_LINTS,
  type Diagnostic,
  type LintKind,
  type ReportContext,
  type RustCrateReport,
} from '../model/types.ts';

export interface LintCount {
  readonly lint: LintKind;
  readonly count: number;
  readonly delta: number | undefined;
}

export interface PackageHotspot {
  readonly name: string;
  readonly total: number;
  readonly byLint: Readonly<Record<string, number>>;
}

export interface QuickWinCycle {
  readonly key: string;
  readonly detail: string;
  readonly location: string | undefined;
}

export interface AggregatedReport {
  readonly projectName: string;
  readonly totalFindings: number;
  readonly deltaTotal: number | undefined;
  readonly baselineLabel: string | undefined;
  readonly activeFindings: number;
  readonly suppressedFindings: number;
  readonly fixedAllowed: number;
  readonly allowPath: string | undefined;
  readonly packageCount: number;
  readonly fileCount: number;
  readonly elapsedLabel: string;
  readonly cachedLabel: string;
  readonly packageCycles: number;
  readonly familyViolations: number;
  readonly featureSliceViolations: number;
  readonly configuredFamilyRules: number;
  readonly lintCounts: readonly LintCount[];
  readonly topHotspots: readonly PackageHotspot[];
  readonly quickWinCycles: readonly QuickWinCycle[];
  readonly rustCrates: readonly RustCrateReport[];
  readonly rustTotal: number;
  readonly diagnostics: readonly Diagnostic[];
}

export function aggregateReport(
  activeDiagnostics: readonly Diagnostic[],
  context?: ReportContext,
): AggregatedReport {
  const source = context?.allDiagnostics ?? activeDiagnostics;
  const counts = new Map<LintKind, number>();
  for (const lint of ALL_LINTS) counts.set(lint, 0);

  const pkgMap = new Map<string, { total: number; byLint: Record<string, number> }>();
  let familyViolations = 0;
  let featureSliceViolations = 0;
  const quickWinCycles: QuickWinCycle[] = [];

  for (const diag of source) {
    counts.set(diag.lint, (counts.get(diag.lint) ?? 0) + 1);

    const pkg = packageLabelOf(diag);
    let bucket = pkgMap.get(pkg);
    if (bucket === undefined) {
      bucket = { total: 0, byLint: {} };
      pkgMap.set(pkg, bucket);
    }
    bucket.total += 1;
    bucket.byLint[diag.lint] = (bucket.byLint[diag.lint] ?? 0) + 1;

    if (diag.lint === 'layer-violation') {
      if (diag.picture.kind === 'boundary' && diag.picture.ruleName === 'feature-slice') {
        featureSliceViolations += 1;
      } else {
        familyViolations += 1;
      }
    }

    if (diag.lint === 'module-cycle') {
      const firstTie = diag.notes[1] ?? '';
      if (firstTie.includes('by 1 item:')) {
        quickWinCycles.push({
          key: diag.key,
          detail: firstTie,
          location:
            diag.location !== undefined
              ? `${diag.location.file}:${diag.location.line}`
              : undefined,
        });
      }
    }
  }

  const baseline = context?.baseline;
  const lintCounts: LintCount[] = [...counts.entries()]
    .map(([lint, count]) => ({
      lint,
      count,
      delta:
        baseline !== undefined
          ? count - (baseline.byLint[lint] ?? 0)
          : undefined,
    }))
    .sort((a, b) => b.count - a.count || a.lint.localeCompare(b.lint));

  const topHotspots: PackageHotspot[] = [...pkgMap.entries()]
    .map(([name, data]) => ({ name, total: data.total, byLint: data.byLint }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const stats = context?.stats;
  const elapsedMs = stats?.elapsedMs ?? 0;
  const elapsedLabel =
    elapsedMs >= 1000
      ? `${(elapsedMs / 1000).toFixed(1)}s`
      : `${elapsedMs}ms`;
  const cachedLabel =
    stats === undefined
      ? ''
      : stats.packagesFromCache > 0 && stats.packagesAnalyzed === 0
        ? 'cached'
        : stats.packagesFromCache > 0
          ? `${stats.packagesFromCache} cached`
          : 'cold';

  const rustCrates = context?.rustCrates ?? [];
  const rustTotal = rustCrates.reduce((sum, c) => sum + c.errorCount, 0);

  return {
    projectName: context?.projectName ?? 'workspace',
    totalFindings: source.length,
    deltaTotal:
      baseline !== undefined ? source.length - baseline.total : undefined,
    baselineLabel: baseline?.label,
    activeFindings: activeDiagnostics.length,
    suppressedFindings: context?.suppressedCount ?? 0,
    fixedAllowed: context?.fixedAllowed ?? 0,
    allowPath: context?.allowPath,
    packageCount: stats?.totalPackages ?? Math.max(1, pkgMap.size),
    fileCount: stats?.files ?? 0,
    elapsedLabel,
    cachedLabel,
    packageCycles: counts.get('package-cycle') ?? 0,
    familyViolations,
    featureSliceViolations,
    configuredFamilyRules: context?.configuredFamilyRules ?? 0,
    lintCounts,
    topHotspots,
    quickWinCycles,
    rustCrates,
    rustTotal,
    diagnostics: source,
  };
}

function packageLabelOf(diag: Diagnostic): string {
  const file = diag.location?.file;
  if (file !== undefined) {
    const parts = file.split('/').filter(Boolean);
    if (parts[0] === 'apps' || parts[0] === 'packages') {
      if (parts.length >= 3 && parts[2] !== 'src') {
        return parts[0] === 'apps'
          ? `${parts[1]}/${parts[2]}`
          : parts[1] === 'ui' || parts[1] === 'router' || parts[1] === 'signal'
            ? `${parts[0]}/${parts[1]}`
            : `${parts[1]}/${parts[2]}`;
      }
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
    }
    if (parts[0] === 'src' && parts.length >= 2) {
      return `src/${parts[1]}`;
    }
  }
  const keyHead = diag.key.split(',')[0] ?? diag.key;
  const slashParts = keyHead.split('/');
  if (keyHead.startsWith('@') && slashParts.length >= 2) {
    return `${slashParts[0]}/${slashParts[1]}`;
  }
  return slashParts[0] ?? 'root';
}
