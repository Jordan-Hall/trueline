/**
 * Output formatters for trueline diagnostics:
 * - `text`: rustc-style ANSI output with clickable file:line:col links & ASCII pictures
 * - `dashboard`: executive CLI dashboard (4 KPI cards, proportional bar charts, Rust strip)
 * - `html`: standalone interactive dark/light HTML health report
 * - `markdown`: GitHub-Flavoured Markdown summary for PRs and `$GITHUB_STEP_SUMMARY`
 * - `json`: deterministic structured JSON for scripts and CI dashboards
 * - `sarif`: SARIF 2.1.0 for GitHub Code Scanning / IDE problem matchers
 */

import type { Diagnostic, ReportContext } from '../model/types.ts';
import { renderCliDashboard } from './dashboard.ts';
import { renderHtmlReport } from './html.ts';
import { renderMarkdownReport } from './markdown.ts';
import { drawPicture, type Painter } from './picture.ts';

export type OutputFormat =
  | 'text'
  | 'dashboard'
  | 'html'
  | 'markdown'
  | 'json'
  | 'sarif';

export interface RenderOptions {
  readonly toolName?: string;
  readonly color?: boolean;
  readonly fixedAllowed?: number;
  readonly allowPath?: string;
  readonly context?: ReportContext;
}

function createPainter(enabled: boolean): Painter {
  const sgr = (code: string, text: string): string =>
    enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    error: (text) => sgr('1;31', text),
    gutter: (text) => sgr('1;34', text),
    ok: (text) => sgr('1;32', text),
    bold: (text) => sgr('1', text),
    dim: (text) => sgr('2', text),
  };
}

export function renderDiagnostics(
  diagnostics: readonly Diagnostic[],
  format: OutputFormat,
  options?: RenderOptions,
): string {
  switch (format) {
    case 'dashboard':
      return renderCliDashboard(
        diagnostics,
        options?.context,
        options?.color ?? false,
        options?.toolName ?? 'trueline',
      );
    case 'html':
      return renderHtmlReport(diagnostics, options?.context);
    case 'markdown':
      return renderMarkdownReport(diagnostics, options?.context);
    case 'json':
      return renderJson(diagnostics, options);
    case 'sarif':
      return renderSarif(diagnostics, options);
    case 'text':
      return renderText(diagnostics, options);
  }
}

/**
 * Generates a shields.io endpoint JSON badge describing current architectural health.
 */
export function renderBadgeJson(
  activeCount: number,
  label = 'trueline',
): string {
  const message =
    activeCount === 0
      ? 'clean'
      : `${activeCount} ${activeCount === 1 ? 'error' : 'errors'}`;
  const color =
    activeCount === 0 ? 'brightgreen' : activeCount <= 10 ? 'orange' : 'red';
  return `${JSON.stringify({ schemaVersion: 1, label, message, color }, null, 2)}\n`;
}

function renderText(
  diagnostics: readonly Diagnostic[],
  options?: RenderOptions,
): string {
  const tool = options?.toolName ?? 'trueline';
  const paint = createPainter(options?.color ?? false);
  const fixedAllowed = options?.fixedAllowed ?? 0;
  const allowPath = options?.allowPath;
  const lines: string[] = [];

  for (const diag of diagnostics) {
    lines.push(
      `${paint.error(`error[${diag.lint}]`)}${paint.bold(`: ${diag.message}`)}`,
    );
    if (diag.location !== undefined) {
      lines.push(
        `  ${paint.gutter('-->')} ${diag.location.file}:${diag.location.line}:${diag.location.column}`,
      );
    }
    for (const note of diag.notes) {
      lines.push(`  ${paint.gutter('=')} ${paint.bold('note:')} ${note}`);
    }
    for (const picLine of drawPicture(diag.picture, paint)) {
      lines.push(picLine);
    }
    lines.push('');
  }

  if (fixedAllowed > 0 && allowPath !== undefined) {
    const noun = fixedAllowed === 1 ? 'entry' : 'entries';
    lines.push(
      `${paint.bold('note:')} ${fixedAllowed} allowed ${noun} in ${allowPath} are now fixed (run \`${tool} --update-allow ${allowPath}\` to tighten it)`,
    );
  }

  if (diagnostics.length === 0) {
    lines.push(`${tool}: ${paint.ok('ok')}`);
  } else {
    const noun = diagnostics.length === 1 ? 'error' : 'errors';
    lines.push(`${tool}: ${paint.error(`${diagnostics.length} ${noun}`)}`);
  }

  return `${lines.join('\n')}\n`;
}

function renderJson(
  diagnostics: readonly Diagnostic[],
  options?: RenderOptions,
): string {
  const byLint: Record<string, number> = {};
  for (const d of diagnostics) {
    byLint[d.lint] = (byLint[d.lint] ?? 0) + 1;
  }
  return `${JSON.stringify(
    {
      tool: options?.toolName ?? 'trueline',
      version: '1.0.0',
      errorCount: diagnostics.length,
      byLint,
      fixedAllowed: options?.fixedAllowed ?? 0,
      stats: options?.context?.stats,
      rustCrates: options?.context?.rustCrates,
      diagnostics,
    },
    null,
    2,
  )}\n`;
}

function renderSarif(
  diagnostics: readonly Diagnostic[],
  options?: RenderOptions,
): string {
  const toolName = options?.toolName ?? 'trueline';
  const rulesMap = new Map<string, { id: string; name: string }>();
  for (const d of diagnostics) {
    if (!rulesMap.has(d.lint)) {
      rulesMap.set(d.lint, { id: d.lint, name: d.lint });
    }
  }

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: toolName,
            version: '1.0.0',
            rules: [...rulesMap.values()],
          },
        },
        results: diagnostics.map((d) => ({
          ruleId: d.lint,
          level: 'error',
          message: {
            text:
              d.notes.length > 0
                ? `${d.message}\n${d.notes.join('\n')}`
                : d.message,
          },
          partialFingerprints: {
            truelineKey: `${d.lint}:${d.key}`,
          },
          locations:
            d.location !== undefined
              ? [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: d.location.file },
                      region: {
                        startLine: d.location.line,
                        startColumn: d.location.column,
                      },
                    },
                  },
                ]
              : [],
        })),
      },
    ],
  };

  return `${JSON.stringify(sarif, null, 2)}\n`;
}
