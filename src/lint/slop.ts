/**
 * Pure lint evaluator for code-hygiene & anti-slop findings:
 * `verbose-comment`, `dead-code`, `silent-catch`, and `type-escape`.
 *
 * Groups occurrences per `(lint, file)` so allowlist keys remain stable when
 * lines shift, while reporting exact clickable sites and rule breakdowns.
 */

import type {
  Diagnostic,
  Model,
  NodeId,
  SlopFinding,
  TextSlopKind,
  TruelineConfig,
} from '../model/types.ts';
import { clickable, counted, inScope } from './helpers.ts';

const LINT_LABELS: Readonly<Record<TextSlopKind, readonly [string, string]>> = {
  'verbose-comment': ['verbose/redundant comment', 'verbose/redundant comments'],
  'dead-code': ['dead code or stub', 'dead code or stub occurrences'],
  'silent-catch': ['silent error catch', 'silent error catches'],
  'type-escape': ['type-safety escape hatch', 'type-safety escape hatches'],
};

export function checkSlop(
  model: Model,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const grouped = new Map<string, { lint: TextSlopKind; filePath: string; findings: SlopFinding[] }>();

  for (const finding of model.slopFindings) {
    if (finding.isTest) continue;
    if (!config.lints[finding.lint]) continue;
    const file = model.files[finding.file];
    if (file === undefined || file.isTest) continue;
    if (!inScope(model.tree, scope, file.moduleNode)) continue;

    const groupKey = `${finding.lint}\0${file.path}`;
    let group = grouped.get(groupKey);
    if (group === undefined) {
      group = { lint: finding.lint, filePath: file.path, findings: [] };
      grouped.set(groupKey, group);
    }
    group.findings.push(finding);
  }

  const diagnostics: Diagnostic[] = [];
  for (const group of grouped.values()) {
    group.findings.sort((a, b) => a.line - b.line || a.column - b.column);
    const first = group.findings[0]!;
    const notes = group.findings
      .slice(0, config.heldInMind)
      .map(
        (f) =>
          `${clickable({ file: group.filePath, line: f.line, column: f.column })}: [${f.rule}] ${f.detail}`,
      );
    if (group.findings.length > config.heldInMind) {
      notes.push(
        `and ${counted(group.findings.length - config.heldInMind, 'more occurrence')}`,
      );
    }

    const [singular, plural] = LINT_LABELS[group.lint];
    diagnostics.push({
      lint: group.lint,
      key: group.filePath,
      message: `\`${group.filePath}\` has ${counted(group.findings.length, singular, plural)}`,
      location: {
        file: group.filePath,
        line: first.line,
        column: first.column,
      },
      notes,
      picture: {
        kind: 'bar',
        label: group.lint,
        length: group.findings.length,
        most: 0,
      },
    });
  }

  return diagnostics;
}
