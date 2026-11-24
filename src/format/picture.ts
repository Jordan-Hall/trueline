/**
 * ASCII box-drawing diagrams rendered beneath each diagnostic.
 *
 * Mirrors deslop-please's visual language: heavy lines highlight the primary
 * defect (cheapest cut edge, leaking field, threshold breach, or forbidden
 * boundary) so diagnostics read clearly with or without ANSI colour.
 */

import type { CycleStep, Picture } from '../model/types.ts';

export interface Painter {
  error(text: string): string;
  gutter(text: string): string;
  ok(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
}

const BAR_WIDTH = 40;

export function drawPicture(picture: Picture, paint: Painter): string[] {
  let raw: string[];
  switch (picture.kind) {
    case 'circle':
      raw = drawCircle(picture.steps, picture.rest, paint);
      break;
    case 'spread':
      raw = drawSpread(
        picture.owner,
        picture.field,
        picture.modules,
        picture.others,
        paint,
      );
      break;
    case 'lists': {
      const rows: { name: string; length: number; judged: boolean }[] = [
        { name: 'shows', length: picture.shown, judged: true },
        { name: 'hides', length: picture.hidden, judged: false },
        ...picture.lists.map((item) => ({
          name: item.name,
          length: item.count,
          judged: true,
        })),
      ];
      raw = drawBars(rows, picture.limit, paint);
      break;
    }
    case 'bar':
      raw = drawBars(
        [{ name: picture.label, length: picture.length, judged: true }],
        picture.most,
        paint,
      );
      break;
    case 'boundary':
      raw = drawBoundary(
        picture.ruleName,
        picture.fromLabel,
        picture.toLabel,
        picture.edges,
        picture.reason,
        paint,
      );
      break;
  }
  return raw.map((line) => `    ${line}`);
}

function shortSite(file: string, line: number): string {
  const trimmed = file.startsWith('src/') ? file.slice(4) : file;
  return `${trimmed}:${line}`;
}

function drawCircle(
  steps: readonly CycleStep[],
  rest: string | undefined,
  paint: Painter,
): string[] {
  if (steps.length === 0) return [];
  const sites = steps.map((step) => shortSite(step.site.file, step.site.line));
  const siteWidth = Math.max(...sites.map((s) => s.length));
  const lines: string[] = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    const site = sites[i]!.padEnd(siteWidth, ' ');
    const isCheapest = i === 0;

    if (i === 0) {
      lines.push(`┌─▶ ${paint.bold(step.member)}`);
    } else {
      lines.push(`│   ${paint.bold(step.member)}`);
    }

    if (isCheapest) {
      const bar = paint.error('┃');
      const arrow = paint.error('▼');
      lines.push(`│     ${bar} ${site}  ${step.uses}`);
      lines.push(`│     ${arrow}`);
    } else if (i < steps.length - 1) {
      lines.push(`│     │ ${site}  ${step.uses}`);
      lines.push('│     ▼');
    } else {
      lines.push(`│     │ ${site}  ${step.uses}`);
      lines.push('└─────┘');
    }
  }

  if (rest !== undefined) {
    lines.push(paint.dim(rest));
  }
  return lines;
}

function drawSpread(
  owner: string,
  field: string,
  modules: readonly { readonly count: number; readonly name: string }[],
  others: readonly string[],
  paint: Painter,
): string[] {
  const lines: string[] = [paint.bold(owner)];
  if (modules.length === 0) return lines;

  const maxDigits = Math.max(...modules.map((m) => String(m.count).length));
  const indent = ' '.repeat(field.length + 3);

  if (modules.length === 1) {
    const only = modules[0]!;
    const arm = paint.error('◀━━━');
    lines.push(`  ${field} ${arm} ${String(only.count).padStart(maxDigits)}  ${only.name}`);
  } else {
    for (let i = 0; i < modules.length; i += 1) {
      const entry = modules[i]!;
      const count = String(entry.count).padStart(maxDigits);
      if (i === 0) {
        const arm = paint.error('◀━┳━');
        lines.push(`  ${field} ${arm} ${count}  ${entry.name}`);
      } else if (i < modules.length - 1) {
        const arm = paint.error('┣━');
        lines.push(`  ${indent}${arm} ${count}  ${entry.name}`);
      } else {
        const arm = paint.error('┗━');
        lines.push(`  ${indent}${arm} ${count}  ${entry.name}`);
      }
    }
  }

  for (const note of others) {
    lines.push(`  ${paint.dim(note)}`);
  }
  return lines;
}

function drawBars(
  rows: readonly { readonly name: string; readonly length: number; readonly judged: boolean }[],
  most: number,
  paint: Painter,
): string[] {
  const unit = Math.max(1, Math.ceil(Math.max(1, most) / (BAR_WIDTH / 2)));
  const thresholdCells = most === 0 ? 0 : Math.ceil(most / unit);
  const nameWidth = Math.max(...rows.map((r) => r.name.length), 0);
  const headerPad = thresholdCells + 1;
  const lines: string[] = [
    `${' '.repeat(nameWidth)}  ${String(most).padStart(headerPad)}`,
  ];

  for (const row of rows) {
    const cells = Math.ceil(row.length / unit);
    const inside = Math.min(cells, thresholdCells);
    const past = cells - inside;
    const maxBeyond = Math.max(1, BAR_WIDTH - thresholdCells);
    let beyond = '█'.repeat(Math.min(past, maxBeyond));
    if (past > maxBeyond) beyond += '⋯';
    if (row.judged && past > 0) {
      beyond = paint.error(beyond);
    }
    const full = '█'.repeat(inside);
    const empty = ' '.repeat(thresholdCells - inside);
    lines.push(
      `${row.name.padEnd(nameWidth)}  ${full}${empty}│${beyond} ${row.length}`,
    );
  }
  return lines;
}

function drawBoundary(
  ruleName: string,
  fromLabel: string,
  toLabel: string,
  edges: readonly { readonly site: { readonly file: string; readonly line: number }; readonly detail: string }[],
  reason: string | undefined,
  paint: Painter,
): string[] {
  const cross = paint.error('━━✕━━▶');
  const lines: string[] = [
    `${paint.bold(fromLabel)} ${cross} ${paint.bold(toLabel)}  ${paint.dim(`[${ruleName}]`)}`,
  ];
  for (const edge of edges.slice(0, 7)) {
    lines.push(`  ${shortSite(edge.site.file, edge.site.line)}  ${edge.detail}`);
  }
  if (edges.length > 7) {
    lines.push(paint.dim(`  …and ${edges.length - 7} more`));
  }
  if (reason !== undefined) {
    lines.push(paint.dim(`  why: ${reason}`));
  }
  return lines;
}
