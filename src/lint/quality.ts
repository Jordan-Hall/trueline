/**
 * Structural code-quality lints:
 * - `pass-through`: exported wrapper functions/methods adding indirection with no logic
 * - `complex-function`: functions exceeding line count, nesting depth, or parameter limits
 * - `duplicate-logic`: structurally identical copy-pasted functions across the workspace
 */

import type {
  Diagnostic,
  FunctionMetric,
  Model,
  NodeId,
  TruelineConfig,
} from '../model/types.ts';
import { clickable, counted, inScope } from './helpers.ts';

export function checkQuality(
  model: Model,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  return [
    ...(config.lints['pass-through']
      ? checkPassThroughWrappers(model, config, scope)
      : []),
    ...(config.lints['complex-function']
      ? checkComplexFunctions(model, config, scope)
      : []),
    ...(config.lints['duplicate-logic']
      ? checkDuplicateLogic(model, config, scope)
      : []),
  ];
}

function checkPassThroughWrappers(
  model: Model,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const byFile = new Map<string, { name: string; target: string; line: number }[]>();

  for (const [itemId, wrapper] of model.wrappers) {
    if (wrapper.kind !== 'forwarder') continue;
    const item = model.items[itemId];
    const targetItem = model.items[wrapper.target];
    if (item === undefined || targetItem === undefined || item.file === undefined) {
      continue;
    }
    if (!item.exported) continue;
    const file = model.files[item.file];
    if (file === undefined || file.isTest || file.isEntrypoint) continue;
    if (!inScope(model.tree, scope, file.moduleNode)) continue;

    let list = byFile.get(file.path);
    if (list === undefined) {
      list = [];
      byFile.set(file.path, list);
    }
    list.push({ name: item.name, target: targetItem.name, line: item.line });
  }

  const out: Diagnostic[] = [];
  for (const [filePath, entries] of byFile) {
    entries.sort((a, b) => a.line - b.line);
    const notes = entries
      .slice(0, config.heldInMind)
      .map((e) => `${filePath}:${e.line}:1: \`${e.name}\` only forwards straight to \`${e.target}\``);
    if (entries.length > config.heldInMind) {
      notes.push(`and ${counted(entries.length - config.heldInMind, 'more pass-through wrapper')}`);
    }
    out.push({
      lint: 'pass-through',
      key: filePath,
      message: `\`${filePath}\` has ${counted(entries.length, 'pass-through wrapper')}`,
      location: { file: filePath, line: entries[0]!.line, column: 1 },
      notes,
      picture: {
        kind: 'bar',
        label: 'wrappers',
        length: entries.length,
        most: 0,
      },
    });
  }
  return out;
}

function checkComplexFunctions(
  model: Model,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const fn of model.functions) {
    if (fn.isTest) continue;
    const file = model.files[fn.file];
    if (file === undefined || file.isTest) continue;
    if (!inScope(model.tree, scope, file.moduleNode)) continue;

    const reasons: string[] = [];
    let barLabel = 'lines';
    let barLength = fn.lines;
    let barMost = config.maxFunctionLines;

    if (fn.lines > config.maxFunctionLines) {
      reasons.push(`${fn.lines} lines (max ${config.maxFunctionLines})`);
    }
    if (fn.maxNesting > config.maxNestingDepth) {
      reasons.push(`nesting depth ${fn.maxNesting} (max ${config.maxNestingDepth})`);
      if (reasons.length === 1) {
        barLabel = 'nesting';
        barLength = fn.maxNesting;
        barMost = config.maxNestingDepth;
      }
    }
    if (fn.paramCount > config.maxParameters) {
      reasons.push(`${fn.paramCount} parameters (max ${config.maxParameters})`);
      if (reasons.length === 1) {
        barLabel = 'params';
        barLength = fn.paramCount;
        barMost = config.maxParameters;
      }
    }

    if (reasons.length === 0) continue;

    out.push({
      lint: 'complex-function',
      key: `${file.path}:${fn.name}`,
      message: `\`${fn.name}\` is too complex: ${reasons.join(', ')}`,
      location: { file: file.path, line: fn.line, column: fn.column },
      notes: [
        `${clickable({ file: file.path, line: fn.line, column: fn.column })}: decompose into cohesive helpers, use early returns, or group options into a typed object`,
      ],
      picture: {
        kind: 'bar',
        label: barLabel,
        length: barLength,
        most: barMost,
      },
    });
  }

  return out;
}

function checkDuplicateLogic(
  model: Model,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const groups = new Map<string, { fn: FunctionMetric; filePath: string }[]>();

  for (const fn of model.functions) {
    if (fn.isTest) continue;
    if (fn.fingerprint === undefined || fn.tokenCount < config.minCloneTokens) {
      continue;
    }
    const file = model.files[fn.file];
    if (file === undefined || file.isTest) continue;

    let list = groups.get(fn.fingerprint);
    if (list === undefined) {
      list = [];
      groups.set(fn.fingerprint, list);
    }
    list.push({ fn, filePath: file.path });
  }

  const out: Diagnostic[] = [];
  for (const [fingerprint, entries] of groups) {
    if (entries.length < 2) continue;
    const concerned = entries.some((e) => {
      const f = model.files[e.fn.file];
      return f !== undefined && inScope(model.tree, scope, f.moduleNode);
    });
    if (!concerned) continue;

    entries.sort(
      (a, b) =>
        a.filePath.localeCompare(b.filePath) || a.fn.line - b.fn.line,
    );
    const first = entries[0]!;
    const memberKeys = entries.map((e) => `${e.filePath}:${e.fn.name}`);
    const notes = entries
      .slice(0, config.heldInMind)
      .map(
        (e) =>
          `${clickable({ file: e.filePath, line: e.fn.line, column: e.fn.column })}: \`${e.fn.name}\` (${e.fn.lines} lines, ${e.fn.tokenCount} tokens)`,
      );
    if (entries.length > config.heldInMind) {
      notes.push(`and ${counted(entries.length - config.heldInMind, 'more clone')}`);
    }

    out.push({
      lint: 'duplicate-logic',
      key: `${fingerprint}:${memberKeys.join(',')}`,
      message: `${counted(entries.length, 'function')} share identical logic (~${first.fn.tokenCount} AST tokens)`,
      location: {
        file: first.filePath,
        line: first.fn.line,
        column: first.fn.column,
      },
      notes,
      picture: {
        kind: 'bar',
        label: 'clones',
        length: entries.length,
        most: 1,
      },
    });
  }

  return out;
}
