/**
 * Narrow public surface for the lint subsystem.
 */

import { buildSemanticGraph } from '../model/graph.ts';
import type {
  Diagnostic,
  LintKind,
  Model,
  NodeId,
  TruelineConfig,
} from '../model/types.ts';
import { checkBoundaries } from './boundaries.ts';
import { checkModuleCycles, checkPackageCycles } from './cycles.ts';
import { formatExplanation } from './explain.ts';
import { checkLayers } from './layers.ts';
import { checkLayout } from './layout.ts';
import { checkFieldLeaks } from './leaks.ts';
import { checkQuality } from './quality.ts';
import { checkShallowModules } from './shallow.ts';
import { checkSlop } from './slop.ts';
import { checkTangles } from './tangles.ts';

export { formatExplanation };

export function resolveScope(
  model: Model,
  query: string,
): NodeId | undefined {
  return model.tree.query(query)[0];
}

export function runLints(
  model: Model,
  config: TruelineConfig,
  scope?: NodeId,
): Diagnostic[] {
  const graph = buildSemanticGraph(model, {
    ignoreTypeOnly: config.ignoreTypeOnlyImports,
  });

  const diagnostics: Diagnostic[] = [];
  if (config.lints['module-cycle']) {
    diagnostics.push(...checkModuleCycles(model, config, scope));
  }
  if (config.lints['package-cycle']) {
    diagnostics.push(...checkPackageCycles(model, config, scope));
  }
  if (config.lints.tangle) {
    diagnostics.push(...checkTangles(model, graph, config, scope));
  }
  if (config.lints['field-leak']) {
    diagnostics.push(...checkFieldLeaks(model, graph, config, scope));
  }
  if (config.lints['shallow-module']) {
    diagnostics.push(...checkShallowModules(model, graph, config, scope));
  }
  if (config.lints['wide-directory'] || config.lints['long-file']) {
    diagnostics.push(...checkLayout(model, config, scope));
  }
  if (config.lints['layer-violation']) {
    diagnostics.push(...checkLayers(model, config, scope));
  }
  diagnostics.push(...checkBoundaries(model, config, scope));
  diagnostics.push(...checkSlop(model, config, scope));
  diagnostics.push(...checkQuality(model, config, scope));

  diagnostics.sort(
    (a, b) => compareLint(a.lint, b.lint) || a.key.localeCompare(b.key),
  );
  return diagnostics;
}

function compareLint(a: LintKind, b: LintKind): number {
  return a.localeCompare(b);
}
