/**
 * `module-cycle` and `package-cycle`:
 *
 * - `module-cycle`: sibling modules inside the same package/directory that use
 *   each other in a circle, so there is no order to read them in.
 * - `package-cycle`: workspace packages that import each other in a circle
 *   (including undeclared imports that sneak around Turborepo's DAG).
 */

import { findCircles } from '../model/graph.ts';
import type {
  Diagnostic,
  Model,
  NodeId,
  TruelineConfig,
} from '../model/types.ts';
import { circleReport, counted, inScope, listed, Tie } from './helpers.ts';

export function checkModuleCycles(
  model: Model,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const tree = model.tree;
  const tiesByParent = new Map<NodeId, Map<string, { user: NodeId; used: NodeId; tie: Tie }>>();

  const getTie = (parent: NodeId, user: NodeId, used: NodeId): Tie => {
    let siblingsMap = tiesByParent.get(parent);
    if (siblingsMap === undefined) {
      siblingsMap = new Map();
      tiesByParent.set(parent, siblingsMap);
    }
    const key = `${user}:${used}`;
    let entry = siblingsMap.get(key);
    if (entry === undefined) {
      entry = { user, used, tie: new Tie() };
      siblingsMap.set(key, entry);
    }
    return entry.tie;
  };

  for (const ref of model.references) {
    if (ref.isTest) continue;
    if (config.ignoreTypeOnlyImports && ref.typeOnly) continue;
    const item = model.items[ref.item];
    if (item === undefined || item.kind === 'module') continue;
    if (tree.node(item.owner).isTest) continue;
    if (item.file !== undefined && model.files[item.file]?.isTest) continue;

    const sib = tree.siblingPair(ref.from, item.owner);
    if (sib === undefined) continue;
    const file = model.files[ref.file];
    if (file === undefined) continue;
    getTie(sib.parent, sib.user, sib.used).addRef(
      file.path,
      ref.line,
      ref.column,
      ref.item,
      ref.holder,
      sib.user,
    );
  }

  for (const imp of model.imports) {
    if (imp.isTest) continue;
    if (config.ignoreTypeOnlyImports && imp.typeOnly) continue;
    if (imp.targetModule === undefined) continue;
    if (imp.targetFile !== undefined && model.files[imp.targetFile]?.isTest) {
      continue;
    }
    if (tree.node(imp.targetModule).isTest) continue;

    const sib = tree.siblingPair(imp.fromModule, imp.targetModule);
    if (sib === undefined) continue;
    const file = model.files[imp.file];
    if (file === undefined) continue;
    const tie = getTie(sib.parent, sib.user, sib.used);
    if (tie.items.size === 0) {
      for (const sym of imp.symbols.length > 0 ? imp.symbols : ['(import)']) {
        tie.addImportSymbol(file.path, imp.line, imp.column, sym, sib.user);
      }
    }
  }

  const diagnostics: Diagnostic[] = [];
  for (const [parent, edges] of tiesByParent) {
    const childSet = new Set<NodeId>();
    for (const edge of edges.values()) {
      childSet.add(edge.user);
      childSet.add(edge.used);
    }
    const children = [...childSet].sort((a, b) => a - b);
    const indexByChild = new Map<NodeId, number>();
    children.forEach((child, idx) => indexByChild.set(child, idx));

    const adjacency: number[][] = Array.from({ length: children.length }, () => []);
    for (const edge of edges.values()) {
      adjacency[indexByChild.get(edge.user)!]!.push(indexByChild.get(edge.used)!);
    }

    for (const circle of findCircles(adjacency)) {
      const members = circle.map((idx) => children[idx]!);
      if (!members.some((m) => inScope(tree, scope, m))) continue;
      const memberSet = new Set(members);
      const inside = [...edges.values()]
        .filter((e) => memberSet.has(e.user) && memberSet.has(e.used))
        .map((e) => ({
          user: tree.node(e.user).name,
          used: tree.node(e.used).name,
          tie: e.tie,
        }));

      const names = members.map((m) => tree.node(m).name).sort();
      const keys = members.map((m) => tree.node(m).displayPath).sort();
      const report = circleReport(
        model,
        'uses',
        'module',
        members.length,
        inside,
        config.heldInMind,
      );

      diagnostics.push({
        lint: 'module-cycle',
        key: keys.join(','),
        message: `${counted(members.length, 'module')} in \`${tree.node(parent).displayPath}\` use each other in a circle`,
        location: report.location,
        notes: [
          `members: ${listed(names, config.heldInMind)}`,
          ...report.notes,
        ],
        picture: report.picture,
      });
    }
  }

  return diagnostics;
}

export function checkPackageCycles(
  model: Model,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const tree = model.tree;
  const edges = new Map<string, { user: NodeId; used: NodeId; tie: Tie }>();

  for (const imp of model.imports) {
    if (imp.isTest) continue;
    if (config.ignoreTypeOnlyImports && imp.typeOnly) continue;
    if (imp.targetPackage === undefined) continue;
    if (imp.fromPackage === imp.targetPackage) continue;

    const file = model.files[imp.file];
    if (file === undefined) continue;

    const key = `${imp.fromPackage}:${imp.targetPackage}`;
    let entry = edges.get(key);
    if (entry === undefined) {
      entry = {
        user: imp.fromPackage,
        used: imp.targetPackage,
        tie: new Tie(),
      };
      edges.set(key, entry);
    }
    const symbols = imp.symbols.length > 0 ? imp.symbols : [imp.specifier];
    for (const sym of symbols) {
      entry.tie.addImportSymbol(
        file.path,
        imp.line,
        imp.column,
        sym,
        imp.fromPackage,
      );
    }
  }

  const pkgSet = new Set<NodeId>();
  for (const edge of edges.values()) {
    pkgSet.add(edge.user);
    pkgSet.add(edge.used);
  }
  const packages = [...pkgSet].sort((a, b) => a - b);
  const indexByPkg = new Map<NodeId, number>();
  packages.forEach((pkg, idx) => indexByPkg.set(pkg, idx));

  const adjacency: number[][] = Array.from({ length: packages.length }, () => []);
  for (const edge of edges.values()) {
    adjacency[indexByPkg.get(edge.user)!]!.push(indexByPkg.get(edge.used)!);
  }

  const diagnostics: Diagnostic[] = [];
  for (const circle of findCircles(adjacency)) {
    const members = circle.map((idx) => packages[idx]!);
    if (!members.some((m) => inScope(tree, scope, m))) continue;
    const memberSet = new Set(members);
    const label = (pkg: NodeId): string =>
      tree.node(pkg).packageName ?? tree.node(pkg).name;

    const inside = [...edges.values()]
      .filter((e) => memberSet.has(e.user) && memberSet.has(e.used))
      .map((e) => ({
        user: label(e.user),
        used: label(e.used),
        tie: e.tie,
      }));

    const names = members.map(label).sort();
    const report = circleReport(
      model,
      'imports',
      'package',
      members.length,
      inside,
      config.heldInMind,
    );

    diagnostics.push({
      lint: 'package-cycle',
      key: names.join(','),
      message: `${counted(members.length, 'workspace package')} depend on each other in a circle`,
      location: report.location,
      notes: [`members: ${listed(names, config.heldInMind)}`, ...report.notes],
      picture: report.picture,
    });
  }

  return diagnostics;
}
