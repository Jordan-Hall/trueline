/**
 * GitHub-Flavoured Markdown summary renderer (`--format markdown`) suited for
 * `$GITHUB_STEP_SUMMARY` and pull-request comments.
 */

import type { Diagnostic, ReportContext } from '../model/types.ts';
import { aggregateReport } from './summary.ts';

export function renderMarkdownReport(
  diagnostics: readonly Diagnostic[],
  context?: ReportContext,
): string {
  const report = aggregateReport(diagnostics, context);
  const lines: string[] = [];

  lines.push(`## ${report.projectName} — Architectural Health Report (\`trueline\`)`);
  lines.push('');

  const deltaStr =
    report.deltaTotal !== undefined
      ? ` (${formatDelta(report.deltaTotal)} vs ${report.baselineLabel ?? 'baseline'})`
      : '';
  const pkgFamily = `${report.packageCycles} / ${report.familyViolations}`;
  const fourthColHead =
    report.rustCrates.length > 0 ? 'Rust Findings' : '1-Item Cycle Cuts';
  const fourthColVal =
    report.rustCrates.length > 0
      ? `${report.rustTotal} (${report.rustCrates.length} crates)`
      : String(report.quickWinCycles.length);

  lines.push(`| TS Scope | TS Findings | Pkg Cycles / Family | ${fourthColHead} |`);
  lines.push('| --- | --- | --- | --- |');
  lines.push(
    `| **${report.packageCount}** pkg(s), ${report.fileCount.toLocaleString('en-GB')} files (${report.elapsedLabel}) | **${report.totalFindings}**${deltaStr} (${report.activeFindings} active) | **${pkgFamily}** | **${fourthColVal}** |`,
  );
  lines.push('');

  const nonZeroLints = report.lintCounts.filter(
    (l) => l.count > 0 || (l.delta !== undefined && l.delta !== 0),
  );
  if (nonZeroLints.length > 0) {
    lines.push('### Findings by Lint');
    lines.push('');
    const hasDelta = report.deltaTotal !== undefined;
    lines.push(hasDelta ? '| Lint | Count | Delta |' : '| Lint | Count |');
    lines.push(hasDelta ? '| --- | ---: | ---: |' : '| --- | ---: |');
    for (const entry of nonZeroLints) {
      if (hasDelta) {
        lines.push(
          `| \`${entry.lint}\` | ${entry.count} | ${formatDelta(entry.delta ?? 0)} |`,
        );
      } else {
        lines.push(`| \`${entry.lint}\` | ${entry.count} |`);
      }
    }
    lines.push('');
  }

  const hotspots = report.topHotspots.slice(0, 8);
  if (hotspots.length > 0) {
    lines.push('### Top Hotspot Packages & Apps');
    lines.push('');
    lines.push('| Package / App | Total | Breakdown |');
    lines.push('| --- | ---: | --- |');
    for (const h of hotspots) {
      const breakdown = Object.entries(h.byLint)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `\`${k}\`: ${v}`)
        .join(', ');
      lines.push(`| \`${h.name}\` | ${h.total} | ${breakdown} |`);
    }
    lines.push('');
  }

  if (report.quickWinCycles.length > 0) {
    lines.push(`### Quick-Win 1-Item Cycle Cuts (${report.quickWinCycles.length})`);
    lines.push('');
    for (const win of report.quickWinCycles.slice(0, 10)) {
      lines.push(`- ${win.detail}`);
    }
    if (report.quickWinCycles.length > 10) {
      lines.push(`- *…and ${report.quickWinCycles.length - 10} more*`);
    }
    lines.push('');
  }

  if (report.rustCrates.length > 0) {
    lines.push('### Rust Crates (`deslop-please`)');
    lines.push('');
    lines.push('| Crate | Status |');
    lines.push('| --- | --- |');
    for (const crate of report.rustCrates) {
      const status =
        crate.status === 'ok'
          ? '0 findings (ok)'
          : crate.status === 'unavailable'
            ? `unavailable (${crate.note ?? 'error'})`
            : `${crate.errorCount} findings`;
      lines.push(`| \`${crate.name}\` | ${status} |`);
    }
    lines.push('');
  }

  if (report.activeFindings === 0) {
    lines.push('**Status:** `trueline: ok`');
  } else {
    lines.push(`**Status:** \`trueline: ${report.activeFindings} active errors\``);
  }
  lines.push('');

  return lines.join('\n');
}

function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `${delta}`;
  return '0';
}
