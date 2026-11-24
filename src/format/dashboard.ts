/**
 * Executive CLI Dashboard renderer using Unicode box-drawing cards and
 * proportional ANSI colour bars — mirrors the visual structure of the
 * HTML health dashboard directly in the terminal.
 */

import type { Diagnostic, ReportContext } from '../model/types.ts';
import { aggregateReport, type AggregatedReport } from './summary.ts';

interface Palette {
  readonly enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  ok(s: string): string;
  warn(s: string): string;
  err(s: string): string;
  border(s: string): string;
  chart(index: number, s: string): string;
}

const CHART_SGR = ['38;5;69', '38;5;43', '38;5;214', '38;5;141', '38;5;204', '38;5;113', '38;5;203', '38;5;78'] as const;

function createPalette(enabled: boolean): Palette {
  const sgr = (code: string, text: string): string =>
    enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    enabled,
    bold: (s) => sgr('1', s),
    dim: (s) => sgr('2', s),
    ok: (s) => sgr('1;32', s),
    warn: (s) => sgr('1;33', s),
    err: (s) => sgr('1;31', s),
    border: (s) => sgr('2;37', s),
    chart: (idx, s) => sgr(CHART_SGR[idx % CHART_SGR.length]!, s),
  };
}

export function renderCliDashboard(
  diagnostics: readonly Diagnostic[],
  context: ReportContext | undefined,
  color: boolean,
  toolName = 'trueline',
): string {
  const report = aggregateReport(diagnostics, context);
  const p = createPalette(color);
  const lines: string[] = [];

  lines.push('');
  lines.push(
    `  ${p.bold(report.projectName.toUpperCase())}  ${p.dim('Architectural Health Dashboard')}`,
  );
  lines.push('');

  // 1. Top 4 KPI cards side-by-side
  const kpiCards = buildKpiCards(report, p);
  lines.push(...renderCardRow(kpiCards, 20, p));
  lines.push('');

  // 2. Two-column bar panels (Findings by Lint | Top Hotspot Packages)
  const leftPanel = buildLintPanel(report, 38, p);
  const rightPanel = buildHotspotPanel(report, 42, p);
  lines.push(...joinColumns(leftPanel, rightPanel, 2));

  // 3. Optional Rust strip when Rust crates were scanned
  if (report.rustCrates.length > 0) {
    lines.push('');
    lines.push(...buildRustStrip(report, 84, p));
  }

  // 4. Quick-win 1-item cycles callout
  if (report.quickWinCycles.length > 0) {
    lines.push('');
    const totalCycles =
      report.lintCounts.find((l) => l.lint === 'module-cycle')?.count ?? 0;
    lines.push(
      `  ${p.bold('Quick Wins:')} ${p.ok(`${report.quickWinCycles.length} of ${totalCycles}`)} module cycles break on a single 1-item edge`,
    );
    for (const win of report.quickWinCycles.slice(0, 5)) {
      lines.push(`    ${p.dim('•')} ${win.detail}`);
    }
    if (report.quickWinCycles.length > 5) {
      lines.push(
        `    ${p.dim(`…and ${report.quickWinCycles.length - 5} more (run with --only module-cycle to inspect all)`)}`,
      );
    }
  }

  lines.push('');
  if (report.fixedAllowed > 0 && report.allowPath !== undefined) {
    lines.push(
      `  ${p.bold('note:')} ${report.fixedAllowed} allowed entries in ${report.allowPath} are now fixed`,
    );
  }
  if (report.activeFindings === 0) {
    lines.push(`  ${toolName}: ${p.ok('ok')}`);
  } else {
    const noun = report.activeFindings === 1 ? 'error' : 'errors';
    lines.push(`  ${toolName}: ${p.err(`${report.activeFindings} active ${noun}`)}`);
  }

  return `${lines.join('\n')}\n`;
}

interface KpiCard {
  readonly label: string;
  readonly value: string;
  readonly valueTone: 'plain' | 'ok' | 'warn' | 'err';
  readonly sub: string;
}

function buildKpiCards(report: AggregatedReport, _p: Palette): KpiCard[] {
  const scopeSub =
    report.fileCount > 0
      ? `${report.fileCount.toLocaleString('en-GB')} files · ${report.elapsedLabel}${report.cachedLabel ? ` ${report.cachedLabel}` : ''}`
      : `${report.elapsedLabel}`;

  const findingsDelta =
    report.deltaTotal !== undefined
      ? ` (${report.deltaTotal > 0 ? `+${report.deltaTotal}` : `${report.deltaTotal}`})`
      : '';
  const findingsSub =
    report.deltaTotal !== undefined
      ? `vs ${report.baselineLabel ?? 'baseline'}`
      : report.allowPath !== undefined && report.suppressedFindings > 0
        ? `Ratcheted (${report.activeFindings} new)`
        : report.activeFindings === 0
          ? 'Clean baseline'
          : `${report.activeFindings} active`;

  const cycleFamilyVal = `${report.packageCycles} / ${report.familyViolations}`;
  const cycleFamilyClean =
    report.packageCycles === 0 && report.familyViolations === 0;
  const cycleFamilySub = cycleFamilyClean
    ? report.configuredFamilyRules > 0
      ? `All ${report.configuredFamilyRules} family rules ok`
      : 'No pkg/family leaks'
    : `${report.packageCycles} cyc · ${report.familyViolations} fam`;

  const fourthCard: KpiCard =
    report.rustCrates.length > 0
      ? {
          label: 'RUST FINDINGS',
          value: String(report.rustTotal),
          valueTone: report.rustTotal === 0 ? 'ok' : 'warn',
          sub: `${report.rustCrates.length} crates (deslop-please)`,
        }
      : {
          label: '1-ITEM CYCLES',
          value: String(report.quickWinCycles.length),
          valueTone: report.quickWinCycles.length === 0 ? 'ok' : 'warn',
          sub: 'Quick-win cycle cuts',
        };

  return [
    {
      label: 'TS SCOPE',
      value: String(report.packageCount),
      valueTone: 'plain',
      sub: scopeSub,
    },
    {
      label: 'TS FINDINGS',
      value: `${report.totalFindings}${findingsDelta}`,
      valueTone:
        report.totalFindings === 0
          ? 'ok'
          : report.deltaTotal !== undefined && report.deltaTotal < 0
            ? 'ok'
            : report.deltaTotal !== undefined && report.deltaTotal > 0
              ? 'err'
              : 'warn',
      sub: findingsSub,
    },
    {
      label: 'PKG / FAMILY',
      value: cycleFamilyVal,
      valueTone: cycleFamilyClean ? 'ok' : 'err',
      sub: cycleFamilySub,
    },
    fourthCard,
  ];
}

function renderCardRow(
  cards: readonly KpiCard[],
  innerWidth: number,
  p: Palette,
): string[] {
  const rendered = cards.map((card) => {
    const label = padVis(card.label, innerWidth);
    const valRaw = padVis(card.value, innerWidth);
    const val =
      card.valueTone === 'ok'
        ? p.ok(valRaw)
        : card.valueTone === 'warn'
          ? p.warn(valRaw)
          : card.valueTone === 'err'
            ? p.err(valRaw)
            : p.bold(valRaw);
    const sub = p.dim(padVis(truncate(card.sub, innerWidth), innerWidth));
    const top = p.border(`╭${'─'.repeat(innerWidth + 2)}╮`);
    const bot = p.border(`╰${'─'.repeat(innerWidth + 2)}╯`);
    const bar = p.border('│');
    return [
      top,
      `${bar} ${p.dim(label)} ${bar}`,
      `${bar} ${val} ${bar}`,
      `${bar} ${sub} ${bar}`,
      bot,
    ];
  });

  const rows: string[] = [];
  for (let lineIdx = 0; lineIdx < 5; lineIdx += 1) {
    rows.push(`  ${rendered.map((card) => card[lineIdx]!).join(' ')}`);
  }
  return rows;
}

function buildLintPanel(
  report: AggregatedReport,
  innerWidth: number,
  p: Palette,
): string[] {
  const headerLeft = 'TypeScript Findings by Lint';
  const headerRight = `${report.totalFindings} total`;
  const maxCount = Math.max(1, ...report.lintCounts.map((l) => l.count));
  const labelW = 16;
  const numW = 5;
  const barW = Math.max(8, innerWidth - labelW - numW - 2);

  const body: string[] = [
    headerRow(headerLeft, headerRight, innerWidth, p),
    p.border('─'.repeat(innerWidth)),
  ];

  report.lintCounts.forEach((entry, idx) => {
    const label = padVis(entry.lint, labelW);
    const bar = drawProportionalBar(entry.count, maxCount, barW, idx, p);
    const num = p.dim(String(entry.count).padStart(numW));
    body.push(`${label} ${bar} ${num}`);
  });

  return boxPanel(body, innerWidth, p);
}

function buildHotspotPanel(
  report: AggregatedReport,
  innerWidth: number,
  p: Palette,
): string[] {
  const top = report.topHotspots.slice(0, 8);
  const headerLeft = 'Top Hotspot Packages & Apps';
  const headerRight = `top ${top.length}`;
  const maxCount = Math.max(1, ...top.map((h) => h.total));
  const labelW = 22;
  const numW = 4;
  const barW = Math.max(8, innerWidth - labelW - numW - 2);

  const body: string[] = [
    headerRow(headerLeft, headerRight, innerWidth, p),
    p.border('─'.repeat(innerWidth)),
  ];

  if (top.length === 0) {
    body.push(p.ok(padVis('No findings across any package!', innerWidth)));
  } else {
    top.forEach((entry, idx) => {
      const label = padVis(truncate(entry.name, labelW), labelW);
      const bar = drawProportionalBar(entry.total, maxCount, barW, idx, p);
      const num = p.dim(String(entry.total).padStart(numW));
      body.push(`${label} ${bar} ${num}`);
    });
  }

  const targetRows = Math.max(10, report.lintCounts.length + 2);
  while (body.length < targetRows) {
    body.push(' '.repeat(innerWidth));
  }

  return boxPanel(body, innerWidth, p);
}

function buildRustStrip(
  report: AggregatedReport,
  innerWidth: number,
  p: Palette,
): string[] {
  const colW = Math.max(18, Math.floor(innerWidth / Math.min(4, report.rustCrates.length)));
  const names: string[] = [];
  const statuses: string[] = [];

  for (const crate of report.rustCrates.slice(0, 4)) {
    names.push(p.dim(padVis(truncate(crate.name, colW - 1), colW)));
    const label =
      crate.status === 'ok'
        ? p.ok(padVis('0 findings (ok)', colW))
        : crate.status === 'unavailable'
          ? p.dim(padVis('unavailable', colW))
          : p.warn(padVis(`${crate.errorCount} findings`, colW));
    statuses.push(label);
  }

  const row1 = names.join('').slice(0);
  const row2 = statuses.join('').slice(0);
  const effectiveW = Math.max(innerWidth, visibleLength(row1), visibleLength(row2));
  return boxPanel(
    [padAnsi(row1, effectiveW), padAnsi(row2, effectiveW)],
    effectiveW,
    p,
  ).map((line) => `  ${line}`);
}

function drawProportionalBar(
  count: number,
  max: number,
  width: number,
  colorIndex: number,
  p: Palette,
): string {
  if (count === 0) return ' '.repeat(width);
  const filled = Math.max(1, Math.round((count / max) * width));
  const solid = p.chart(colorIndex, '━'.repeat(filled));
  const empty = p.dim('·'.repeat(Math.max(0, width - filled)));
  return `${solid}${empty}`;
}

function headerRow(
  left: string,
  right: string,
  width: number,
  p: Palette,
): string {
  const gap = Math.max(1, width - left.length - right.length);
  return `${p.bold(left)}${' '.repeat(gap)}${p.dim(right)}`;
}

function boxPanel(body: readonly string[], innerWidth: number, p: Palette): string[] {
  const bar = p.border('│');
  return [
    p.border(`╭${'─'.repeat(innerWidth + 2)}╮`),
    ...body.map((line) => `${bar} ${padAnsi(line, innerWidth)} ${bar}`),
    p.border(`╰${'─'.repeat(innerWidth + 2)}╯`),
  ];
}

function joinColumns(
  left: readonly string[],
  right: readonly string[],
  gap: number,
): string[] {
  const height = Math.max(left.length, right.length);
  const leftW = Math.max(...left.map(visibleLength), 0);
  const spacer = ' '.repeat(gap);
  const out: string[] = [];
  for (let i = 0; i < height; i += 1) {
    const l = left[i] ?? ' '.repeat(leftW);
    const r = right[i] ?? '';
    out.push(`  ${padAnsi(l, leftW)}${spacer}${r}`);
  }
  return out;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= 1 ? text.slice(0, max) : `${text.slice(0, max - 1)}…`;
}

function padVis(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width, ' ');
}

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padAnsi(text: string, width: number): string {
  const diff = width - visibleLength(text);
  return diff > 0 ? `${text}${' '.repeat(diff)}` : text;
}
