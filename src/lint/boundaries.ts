/**
 * Package & module boundary hygiene lints:
 * - `undeclared-dep`: importing a workspace package not listed in package.json
 * - `unused-export`: exporting symbols from internal modules with zero external importers
 * - `wildcard-barrel`: `export * from '...'` barrels that obscure boundaries
 */

import type {
  Diagnostic,
  FileId,
  ItemId,
  Location,
  Model,
  NodeId,
  TruelineConfig,
} from '../model/types.ts';
import { clickable, counted, inScope, listed } from './helpers.ts';

export function checkBoundaries(
  model: Model,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (config.lints['undeclared-dep']) {
    diagnostics.push(...checkUndeclaredDeps(model, config, scope));
  }
  if (config.lints['wildcard-barrel']) {
    diagnostics.push(...checkWildcardBarrels(model, config, scope));
  }
  if (config.lints['unused-export']) {
    diagnostics.push(...checkUnusedExports(model, config, scope));
  }
  return diagnostics;
}

function checkUndeclaredDeps(
  model: Model,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const tree = model.tree;
  const violations = new Map<
    string,
    { fromPkg: string; targetPkg: string; edges: { site: Location; detail: string }[] }
  >();

  for (const imp of model.imports) {
    if (imp.isTest) continue;
    if (config.ignoreTypeOnlyImports && imp.typeOnly) continue;
    if (imp.targetPackage === undefined || imp.targetPackage === imp.fromPackage) {
      continue;
    }
    const file = model.files[imp.file];
    if (file === undefined) continue;
    if (!inScope(tree, scope, file.moduleNode)) continue;

    const fromNode = tree.node(imp.fromPackage);
    const targetNode = tree.node(imp.targetPackage);
    const targetName = targetNode.packageName ?? targetNode.name;
    if (fromNode.declaredDeps.includes(targetName)) continue;

    const fromName = fromNode.packageName ?? fromNode.name;
    const key = `${fromName}->${targetName}`;
    let bucket = violations.get(key);
    if (bucket === undefined) {
      bucket = { fromPkg: fromName, targetPkg: targetName, edges: [] };
      violations.set(key, bucket);
    }
    bucket.edges.push({
      site: { file: file.path, line: imp.line, column: imp.column },
      detail: `imports \`${imp.specifier}\``,
    });
  }

  const out: Diagnostic[] = [];
  for (const [key, bucket] of violations) {
    const notes = bucket.edges
      .slice(0, config.heldInMind)
      .map((e) => `${clickable(e.site)}: ${e.detail}`);
    if (bucket.edges.length > config.heldInMind) {
      notes.push(`and ${counted(bucket.edges.length - config.heldInMind, 'more import')}`);
    }
    notes.push(`Add "${bucket.targetPkg}" to ${bucket.fromPkg}'s package.json.`);
    out.push({
      lint: 'undeclared-dep',
      key,
      message: `\`${bucket.fromPkg}\` imports undeclared workspace dependency \`${bucket.targetPkg}\` (${counted(bucket.edges.length, 'import')})`,
      location: bucket.edges[0]?.site,
      notes,
      picture: {
        kind: 'boundary',
        ruleName: 'undeclared-dep',
        fromLabel: bucket.fromPkg,
        toLabel: bucket.targetPkg,
        edges: bucket.edges,
        reason: 'Phantom hoisted imports break under strict workspace isolation.',
      },
    });
  }
  return out;
}

function checkWildcardBarrels(
  model: Model,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const byFile = new Map<string, { site: Location; specifier: string }[]>();

  for (const imp of model.imports) {
    if (imp.isTest || !imp.isWildcardReExport) continue;
    const file = model.files[imp.file];
    if (file === undefined || file.isTest) continue;
    if (!inScope(model.tree, scope, file.moduleNode)) continue;

    let list = byFile.get(file.path);
    if (list === undefined) {
      list = [];
      byFile.set(file.path, list);
    }
    list.push({
      site: { file: file.path, line: imp.line, column: imp.column },
      specifier: imp.specifier,
    });
  }

  const out: Diagnostic[] = [];
  for (const [filePath, entries] of byFile) {
    entries.sort((a, b) => a.site.line - b.site.line);
    const notes = entries
      .slice(0, config.heldInMind)
      .map((e) => `${clickable(e.site)}: \`export * from '${e.specifier}'\``);
    if (entries.length > config.heldInMind) {
      notes.push(`and ${counted(entries.length - config.heldInMind, 'more wildcard re-export')}`);
    }
    out.push({
      lint: 'wildcard-barrel',
      key: filePath,
      message: `\`${filePath}\` uses ${counted(entries.length, 'wildcard barrel re-export')}`,
      location: entries[0]?.site,
      notes,
      picture: {
        kind: 'bar',
        label: 'export *',
        length: entries.length,
        most: 0,
      },
    });
  }
  return out;
}

function checkUnusedExports(
  model: Model,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  // Collect every item referenced from a file OTHER than its declaring file
  // (including tests, plus symbols explicitly named in import/re-export clauses).
  const referencedExternally = new Set<ItemId>();
  const importedNamesByTargetFile = new Map<FileId, Set<string>>();
  const wildcardImportedFiles = new Set<FileId>();

  for (const ref of model.references) {
    const item = model.items[ref.item];
    if (item === undefined || item.file === undefined) continue;
    if (ref.file !== item.file) {
      referencedExternally.add(ref.item);
    }
  }

  for (const imp of model.imports) {
    if (imp.targetFile === undefined) continue;
    if (imp.symbols.includes('*')) {
      wildcardImportedFiles.add(imp.targetFile);
      continue;
    }
    let set = importedNamesByTargetFile.get(imp.targetFile);
    if (set === undefined) {
      set = new Set();
      importedNamesByTargetFile.set(imp.targetFile, set);
    }
    for (const sym of imp.symbols) set.add(sym);
  }

  // Types referenced in the same file by an exported declaration (or by a member
  // of an exported class) are part of its public signature for `.d.ts` emission.
  const referencedByExportInSameFile = new Set<ItemId>();
  for (const ref of model.references) {
    const target = model.items[ref.item];
    const holder = ref.holder !== undefined ? model.items[ref.holder] : undefined;
    const holderExported =
      holder !== undefined &&
      (holder.exported ||
        (holder.parent !== undefined &&
          model.items[holder.parent]?.exported === true));
    if (
      target !== undefined &&
      target.kind === 'type' &&
      holderExported &&
      target.file === ref.file
    ) {
      referencedByExportInSameFile.add(target.id);
    }
  }

  const unusedByFile = new Map<
    string,
    { fileId: FileId; items: { name: string; line: number }[] }
  >();

  for (const item of model.items) {
    if (!item.exported || item.parent !== undefined || item.file === undefined) {
      continue;
    }
    const file = model.files[item.file];
    if (file === undefined || file.isTest || file.isEntrypoint) continue;
    if (!inScope(model.tree, scope, file.moduleNode)) continue;
    if (referencedExternally.has(item.id)) continue;
    if (referencedByExportInSameFile.has(item.id)) continue;
    if (wildcardImportedFiles.has(item.file)) continue;
    if (importedNamesByTargetFile.get(item.file)?.has(item.name)) continue;

    let bucket = unusedByFile.get(file.path);
    if (bucket === undefined) {
      bucket = { fileId: item.file, items: [] };
      unusedByFile.set(file.path, bucket);
    }
    bucket.items.push({ name: item.name, line: item.line });
  }

  const out: Diagnostic[] = [];
  for (const [filePath, bucket] of unusedByFile) {
    bucket.items.sort((a, b) => a.line - b.line);
    const names = bucket.items.map((i) => i.name);
    const first = bucket.items[0]!;
    out.push({
      lint: 'unused-export',
      key: filePath,
      message: `\`${filePath}\` has ${counted(bucket.items.length, 'unused export')}: ${listed(names, config.heldInMind)}`,
      location: { file: filePath, line: first.line, column: 1 },
      notes: bucket.items
        .slice(0, config.heldInMind)
        .map((i) => `${filePath}:${i.line}:1: \`${i.name}\` is never imported outside this file`),
      picture: {
        kind: 'bar',
        label: 'unused',
        length: bucket.items.length,
        most: 0,
      },
    });
  }
  return out;
}
