/**
 * Standalone, zero-dependency HTML architectural health dashboard.
 *
 * Matches the sleek dark/light card aesthetic (4 KPI cards, 2 proportional bar
 * chart panels, optional Rust strip) and adds interactive lint/package filters,
 * 1-item quick-win cycles, and a searchable diagnostics explorer.
 */

import type { Diagnostic, ReportContext } from '../model/types.ts';
import { aggregateReport, type AggregatedReport } from './summary.ts';

const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--destructive)',
  'var(--success)',
] as const;

export function renderHtmlReport(
  diagnostics: readonly Diagnostic[],
  context?: ReportContext,
): string {
  const report = aggregateReport(diagnostics, context);
  const maxLint = Math.max(1, ...report.lintCounts.map((l) => l.count));
  const topHotspots = report.topHotspots.slice(0, 8);
  const maxHotspot = Math.max(1, ...topHotspots.map((h) => h.total));

  const scopeSub =
    report.fileCount > 0
      ? `${report.fileCount.toLocaleString('en-GB')} files · ${report.elapsedLabel}${report.cachedLabel ? ` ${report.cachedLabel}` : ''}`
      : report.elapsedLabel;

  const findingsDelta =
    report.deltaTotal !== undefined
      ? ` <span class="${report.deltaTotal > 0 ? 'err' : report.deltaTotal < 0 ? 'ok' : 'muted'}" style="font-size:13px">${report.deltaTotal > 0 ? `+${report.deltaTotal}` : report.deltaTotal}</span>`
      : '';
  const findingsSub =
    report.deltaTotal !== undefined
      ? `Compared with ${escapeHtml(report.baselineLabel ?? 'baseline')}`
      : report.allowPath !== undefined && report.suppressedFindings > 0
        ? `Ratcheted in ${escapeHtml(report.allowPath)} (${report.activeFindings} new)`
        : report.activeFindings === 0
          ? 'Zero active violations'
          : `${report.activeFindings} active violations`;

  const cycleFamilyClean =
    report.packageCycles === 0 && report.familyViolations === 0;
  const cycleFamilySub = cycleFamilyClean
    ? report.configuredFamilyRules > 0
      ? `All ${report.configuredFamilyRules} family layers clean`
      : 'No package or family cycles'
    : `${report.packageCycles} pkg cycle · ${report.familyViolations} family`;

  const fourthKpi =
    report.rustCrates.length > 0
      ? `<div class="kpi">
          <div class="kpi-label">Rust Findings</div>
          <div class="kpi-val ${report.rustTotal === 0 ? 'ok' : 'warn'}">${report.rustTotal}</div>
          <div class="kpi-sub">${report.rustCrates.length} crates via deslop-please</div>
        </div>`
      : `<div class="kpi">
          <div class="kpi-label">1-Item Cycle Cuts</div>
          <div class="kpi-val ${report.quickWinCycles.length === 0 ? 'ok' : 'warn'}">${report.quickWinCycles.length}</div>
          <div class="kpi-sub">Quick-win cycle refactors</div>
        </div>`;

  const lintRows = report.lintCounts
    .map((entry, idx) => {
      const pct = entry.count === 0 ? 0 : Math.max(1.5, (entry.count / maxLint) * 100);
      const color = CHART_COLORS[idx % CHART_COLORS.length]!;
      return `<button type="button" class="bar-row interactive" data-filter-lint="${escapeHtml(entry.lint)}">
        <span class="bar-label">${escapeHtml(entry.lint)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></span></span>
        <span class="bar-num">${entry.count}</span>
      </button>`;
    })
    .join('\n      ');

  const hotspotRows =
    topHotspots.length === 0
      ? '<div class="empty-msg">Zero findings across all packages.</div>'
      : topHotspots
          .map((entry, idx) => {
            const pct = Math.max(2, (entry.total / maxHotspot) * 100);
            const color = CHART_COLORS[idx % CHART_COLORS.length]!;
            const breakdown = Object.entries(entry.byLint)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ');
            return `<button type="button" class="bar-row pkg interactive" data-filter-pkg="${escapeHtml(entry.name)}" title="${escapeHtml(breakdown)}">
        <span class="bar-label">${escapeHtml(entry.name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></span></span>
        <span class="bar-num">${entry.total}</span>
      </button>`;
          })
          .join('\n      ');

  const rustSection =
    report.rustCrates.length > 0
      ? `<div class="rust-strip">
      ${report.rustCrates
        .map((crate) => {
          const cls =
            crate.status === 'ok'
              ? 'ok'
              : crate.status === 'unavailable'
                ? 'muted'
                : 'warn';
          const label =
            crate.status === 'ok'
              ? '0 findings (ok)'
              : crate.status === 'unavailable'
                ? escapeHtml(crate.note ?? 'unavailable')
                : `${crate.errorCount} findings`;
          return `<div class="rust-item">
        <div class="rust-name">${escapeHtml(crate.name)}</div>
        <div class="rust-val ${cls}">${label}</div>
      </div>`;
        })
        .join('\n      ')}
    </div>`
      : '';

  const embeddedData = safeJsonForScript(buildExplorerPayload(report));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(report.projectName)} — Architectural Health Report (trueline)</title>
<style>${HTML_STYLES}</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <div>
      <div class="title">${escapeHtml(report.projectName)} — Architectural Health Report</div>
      <div class="subtitle">Generated by trueline · Click any lint or package bar to filter findings below</div>
    </div>
    <button type="button" class="theme-btn" id="themeToggle">Toggle theme</button>
  </div>

  <div class="grid">
    <div class="kpi">
      <div class="kpi-label">TS Scope</div>
      <div class="kpi-val">${report.packageCount}</div>
      <div class="kpi-sub">${escapeHtml(scopeSub)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">TS Findings</div>
      <div class="kpi-val ${report.totalFindings === 0 ? 'ok' : 'warn'}">${report.totalFindings}${findingsDelta}</div>
      <div class="kpi-sub">${findingsSub}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Pkg Cycles / Family</div>
      <div class="kpi-val ${cycleFamilyClean ? 'ok' : 'err'}">${report.packageCycles} / ${report.familyViolations}</div>
      <div class="kpi-sub">${escapeHtml(cycleFamilySub)}</div>
    </div>
    ${fourthKpi}
  </div>

  <div class="panels">
    <div class="panel">
      <div class="panel-title">TypeScript Findings by Lint <span>${report.totalFindings} total</span></div>
      ${lintRows}
    </div>
    <div class="panel">
      <div class="panel-title">Top Hotspot Packages &amp; Apps <span>top ${topHotspots.length}</span></div>
      ${hotspotRows}
    </div>
  </div>

  ${rustSection}

  <div class="explorer">
    <div class="panel-title">Findings Explorer <span id="shownCount"></span></div>
    <div class="controls">
      <input class="search" id="searchBox" type="search" placeholder="Filter by symbol, file path, package, or message..." />
      <button type="button" class="pill" id="quickWinBtn">1-item cycle cuts (${report.quickWinCycles.length})</button>
      <button type="button" class="pill" id="clearBtn">Clear filters</button>
    </div>
    <div id="list"></div>
  </div>
</div>

<script id="trueline-data" type="application/json">${embeddedData}</script>
<script>${EXPLORER_SCRIPT}</script>
</body>
</html>
`;
}

const HTML_STYLES = `
  :root {
    --background: #0a0a0c;
    --foreground: #f4f4f5;
    --muted-foreground: #a1a1aa;
    --card: #121216;
    --secondary: #1e1e24;
    --border: #26262e;
    --success: #22c55e;
    --warning: #f59e0b;
    --destructive: #ef4444;
    --chart-1: #3b82f6;
    --chart-2: #14b8a6;
    --chart-3: #f59e0b;
    --chart-4: #a78bfa;
    --chart-5: #fb7185;
    --chart-6: #84cc16;
    --radius: 10px;
    --font-sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --background: #fafafa;
      --foreground: #18181b;
      --muted-foreground: #71717a;
      --card: #ffffff;
      --secondary: #f4f4f5;
      --border: #e4e4e7;
    }
  }
  :root[data-theme="light"] {
    --background: #fafafa;
    --foreground: #18181b;
    --muted-foreground: #71717a;
    --card: #ffffff;
    --secondary: #f4f4f5;
    --border: #e4e4e7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--font-sans);
    color: var(--foreground);
    background: var(--background);
    font-size: 13px;
    line-height: 1.45;
    padding: 20px;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
    gap: 12px;
  }
  .title { font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
  .subtitle { font-size: 12px; color: var(--muted-foreground); }
  .theme-btn {
    background: var(--card);
    color: var(--foreground);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 11px;
    cursor: pointer;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 14px;
  }
  @media (max-width: 680px) { .grid { grid-template-columns: repeat(2, 1fr); } }
  .kpi {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 13px 15px;
  }
  .kpi-label {
    font-size: 11px;
    color: var(--muted-foreground);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .kpi-val {
    font-size: 24px;
    font-weight: 700;
    margin-top: 3px;
    font-variant-numeric: tabular-nums;
  }
  .kpi-sub { font-size: 11px; color: var(--muted-foreground); margin-top: 3px; }
  .ok { color: var(--success); }
  .warn { color: var(--warning); }
  .err { color: var(--destructive); }
  .muted { color: var(--muted-foreground); }
  .panels {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  @media (max-width: 720px) { .panels { grid-template-columns: 1fr; } }
  .panel {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 15px 17px;
  }
  .panel-title {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 12px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .panel-title span { font-size: 11px; font-weight: 400; color: var(--muted-foreground); }
  .bar-row {
    width: 100%;
    background: transparent;
    border: 0;
    color: inherit;
    text-align: left;
    display: grid;
    grid-template-columns: 132px 1fr 42px;
    align-items: center;
    gap: 10px;
    padding: 3px 4px;
    margin-bottom: 4px;
    border-radius: 5px;
  }
  .bar-row.pkg { grid-template-columns: 185px 1fr 38px; }
  .bar-row.interactive { cursor: pointer; }
  .bar-row.interactive:hover, .bar-row.active { background: var(--secondary); }
  .bar-label {
    font-family: var(--font-mono);
    font-size: 11.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bar-track {
    height: 10px;
    background: var(--secondary);
    border-radius: 5px;
    overflow: hidden;
    display: block;
  }
  .bar-fill { height: 100%; border-radius: 5px; display: block; }
  .bar-num {
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-align: right;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
  }
  .rust-strip {
    margin-top: 12px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 13px 16px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
  }
  .rust-name { font-family: var(--font-mono); font-size: 11px; color: var(--muted-foreground); }
  .rust-val { font-size: 13px; font-weight: 600; margin-top: 2px; }
  .explorer {
    margin-top: 14px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 15px 17px;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
    align-items: center;
  }
  .search {
    flex: 1;
    min-width: 200px;
    background: var(--secondary);
    color: var(--foreground);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12px;
  }
  .pill {
    background: var(--secondary);
    color: var(--foreground);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 11px;
    cursor: pointer;
  }
  .pill.active { border-color: var(--chart-1); color: var(--chart-1); }
  .finding { border-top: 1px solid var(--border); padding: 9px 0; }
  #list { max-height: 460px; overflow-y: auto; }
  .finding-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .badge {
    font-family: var(--font-mono);
    font-size: 10.5px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--secondary);
    border: 1px solid var(--border);
  }
  .loc { font-family: var(--font-mono); font-size: 11px; color: var(--muted-foreground); }
  .notes {
    margin-top: 4px;
    padding-left: 14px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted-foreground);
  }
  .empty-msg { color: var(--muted-foreground); font-size: 12px; padding: 8px 0; }
`;

const EXPLORER_SCRIPT = `
(() => {
  const payload = JSON.parse(document.getElementById('trueline-data').textContent);
  let activeLint = '';
  let activePkg = '';
  let onlyQuickWins = false;
  const searchBox = document.getElementById('searchBox');
  const listEl = document.getElementById('list');
  const shownEl = document.getElementById('shownCount');
  const quickWinBtn = document.getElementById('quickWinBtn');

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function render() {
    const q = searchBox.value.trim().toLowerCase();
    const filtered = payload.items.filter((item) => {
      if (activeLint && item.lint !== activeLint) return false;
      if (activePkg && !item.file.includes(activePkg) && !item.key.includes(activePkg)) return false;
      if (onlyQuickWins && !item.quickWin) return false;
      if (q && !(item.key + ' ' + item.message + ' ' + item.file + ' ' + item.notes.join(' ')).toLowerCase().includes(q)) return false;
      return true;
    });

    shownEl.textContent = filtered.length + ' of ' + payload.items.length + ' shown';
    document.querySelectorAll('[data-filter-lint]').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-filter-lint') === activeLint);
    });
    document.querySelectorAll('[data-filter-pkg]').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-filter-pkg') === activePkg);
    });
    quickWinBtn.classList.toggle('active', onlyQuickWins);

    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="empty-msg">No findings match the current filter.</div>';
      return;
    }

    const cap = 150;
    const slice = filtered.slice(0, cap);
    listEl.innerHTML = slice.map((item) => {
      const notes = item.notes.slice(0, 4).map((n) => '<div>' + esc(n) + '</div>').join('');
      return '<div class="finding">' +
        '<div class="finding-head">' +
          '<span class="badge">' + esc(item.lint) + '</span>' +
          '<strong>' + esc(item.message) + '</strong>' +
          (item.loc ? '<span class="loc">' + esc(item.loc) + '</span>' : '') +
        '</div>' +
        (notes ? '<div class="notes">' + notes + '</div>' : '') +
      '</div>';
    }).join('') + (filtered.length > cap ? '<div class="empty-msg">Showing first ' + cap + ' of ' + filtered.length + ' matching findings. Narrow your filter to inspect the rest.</div>' : '');
  }

  document.querySelectorAll('[data-filter-lint]').forEach((el) => {
    el.addEventListener('click', () => {
      const val = el.getAttribute('data-filter-lint');
      activeLint = activeLint === val ? '' : val;
      onlyQuickWins = false;
      render();
    });
  });
  document.querySelectorAll('[data-filter-pkg]').forEach((el) => {
    el.addEventListener('click', () => {
      const val = el.getAttribute('data-filter-pkg');
      activePkg = activePkg === val ? '' : val;
      render();
    });
  });
  quickWinBtn.addEventListener('click', () => {
    onlyQuickWins = !onlyQuickWins;
    if (onlyQuickWins) activeLint = 'module-cycle';
    render();
  });
  document.getElementById('clearBtn').addEventListener('click', () => {
    activeLint = '';
    activePkg = '';
    onlyQuickWins = false;
    searchBox.value = '';
    render();
  });
  searchBox.addEventListener('input', render);
  document.getElementById('themeToggle').addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme');
    root.setAttribute('data-theme', current === 'light' ? 'dark' : 'light');
  });
  render();
})();
`;

function buildExplorerPayload(report: AggregatedReport) {
  return {
    items: report.diagnostics.map((d) => ({
      lint: d.lint,
      key: d.key,
      message: d.message,
      file: d.location?.file ?? '',
      loc: d.location !== undefined ? `${d.location.file}:${d.location.line}` : '',
      notes: d.notes.slice(0, 5),
      quickWin:
        d.lint === 'module-cycle' && (d.notes[1] ?? '').includes('by 1 item:'),
    })),
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
