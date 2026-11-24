/**
 * `shallow-module`: a package, or a module with child modules, that shows more
 * working functions than a reader holds in mind (`heldInMind`, default 7),
 * hides at most as many as it shows (`hidden <= shown * breakEven`), and has
 * at least one conceptual list (things shown, or functions of one type)
 * exceeding `heldInMind`.
 *
 * Wrappers (forwarders, trivial getters, barrel re-exports) and lifecycle
 * methods count for nothing.
 */

import type { SemanticGraph, ThingId } from '../model/graph.ts';
import type {
  Diagnostic,
  ItemId,
  Model,
  ModuleTree,
  NodeId,
  TruelineConfig,
} from '../model/types.ts';
import {
  counted,
  inScope,
  listed,
  moduleLocation,
  stripGenerics,
} from './helpers.ts';

export function checkShallowModules(
  model: Model,
  graph: SemanticGraph,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const tree = model.tree;
  const judged = new Set(tree.query());
  const homeOf = (itemId: ItemId): NodeId | undefined => {
    const thing = graph.thingOf[itemId];
    return thing !== undefined ? graph.things[thing]!.home : undefined;
  };
  const isWorking = (itemId: ItemId): boolean => {
    const item = model.items[itemId];
    return (
      item !== undefined &&
      item.kind === 'function' &&
      !item.isLifecycle &&
      !model.wrappers.has(itemId)
    );
  };

  const totalByModule = new Map<NodeId, number>();
  for (let id = 0; id < model.items.length; id += 1) {
    if (!isWorking(id)) continue;
    const home = homeOf(id);
    if (home === undefined) continue;
    for (const mod of tree.scopeChain(home)) {
      if (judged.has(mod)) {
        totalByModule.set(mod, (totalByModule.get(mod) ?? 0) + 1);
      }
    }
  }

  const shownByModule = new Map<NodeId, Set<ItemId>>();
  for (const usage of graph.uses) {
    if (!isWorking(usage.item)) continue;
    const at = homeOf(usage.item);
    if (at === undefined) continue;
    const ref = model.references[usage.referenceIndex]!;
    const userNode =
      usage.user !== undefined ? graph.things[usage.user]!.home : ref.from;

    for (const mod of tree.scopeChain(at)) {
      if (withinSamePackage(tree, userNode, mod)) break;
      if (judged.has(mod)) {
        let set = shownByModule.get(mod);
        if (set === undefined) {
          set = new Set();
          shownByModule.set(mod, set);
        }
        set.add(usage.item);
      }
    }
  }

  const knownTypes = collectTypesKnown(model, graph);
  const diagnostics: Diagnostic[] = [];

  for (const mod of judged) {
    const total = totalByModule.get(mod) ?? 0;
    const shown = shownByModule.get(mod);
    if (shown === undefined || shown.size <= config.heldInMind) continue;

    const hidden = Math.max(0, total - shown.size);
    if (hidden > shown.size * config.breakEven) continue;

    const grouped = buildInterfaceLists(model, graph, knownTypes, mod, shown);
    const { notes, longLists } = findTooLongLists(grouped, config.heldInMind);
    if (notes.length === 0) continue;
    if (!inScope(tree, scope, mod)) continue;

    const name = tree.node(mod).displayPath;
    diagnostics.push({
      lint: 'shallow-module',
      key: name,
      message: `\`${name}\` is shallow: it shows ${shown.size} of its ${counted(total, 'function')}`,
      location: moduleLocation(model, mod),
      notes,
      picture: {
        kind: 'lists',
        shown: shown.size,
        hidden,
        lists: longLists,
        limit: config.heldInMind,
      },
    });
  }

  return diagnostics;
}

function withinSamePackage(
  tree: ModuleTree,
  node: NodeId,
  ancestor: NodeId,
): boolean {
  return (
    tree.isWithin(node, ancestor) &&
    tree.node(node).packageId === tree.node(ancestor).packageId
  );
}

function collectTypesKnown(
  model: Model,
  graph: SemanticGraph,
): Map<ThingId, Set<ThingId>> {
  const kindOf = (thing: ThingId) => model.items[graph.things[thing]!.item]!.kind;
  const known = new Map<ThingId, Set<ThingId>>();
  for (const usage of graph.uses) {
    if (usage.user === undefined) continue;
    const used = graph.thingOf[usage.item];
    if (used === undefined) continue;
    if (kindOf(usage.user) === 'function' && kindOf(used) === 'type') {
      let set = known.get(usage.user);
      if (set === undefined) {
        set = new Set();
        known.set(usage.user, set);
      }
      set.add(used);
    }
  }
  return known;
}

function buildInterfaceLists(
  model: Model,
  graph: SemanticGraph,
  knownTypes: ReadonlyMap<ThingId, ReadonlySet<ThingId>>,
  moduleNode: NodeId,
  shown: ReadonlySet<ItemId>,
): { name: string; functions: string[] }[] {
  const nameOf = (itemId: ItemId): string =>
    stripGenerics(model.items[itemId]!.name);
  const lists = new Map<ThingId, Set<string>>();

  for (const fnId of shown) {
    const thing = graph.thingOf[fnId];
    if (thing === undefined) continue;
    let targets: ThingId[] = [thing];
    if (graph.things[thing]!.item === fnId) {
      const referencedTypes = [...(knownTypes.get(thing) ?? [])].filter((ty) =>
        withinSamePackage(model.tree, graph.things[ty]!.home, moduleNode),
      );
      if (referencedTypes.length > 0) {
        targets = referencedTypes;
      }
    }
    for (const target of targets) {
      let set = lists.get(target);
      if (set === undefined) {
        set = new Set();
        lists.set(target, set);
      }
      set.add(nameOf(fnId));
    }
  }

  return [...lists.entries()]
    .map(([thing, fns]) => ({
      name: nameOf(graph.things[thing]!.item),
      functions: [...fns].sort(),
    }))
    .sort(
      (a, b) =>
        b.functions.length - a.functions.length || a.name.localeCompare(b.name),
    );
}

function findTooLongLists(
  lists: readonly { name: string; functions: string[] }[],
  limit: number,
): {
  notes: string[];
  longLists: { name: string; count: number }[];
} {
  const notes: string[] = [];
  const longLists: { name: string; count: number }[] = [];

  if (lists.length > limit) {
    notes.push(
      `shows ${counted(lists.length, 'thing')}: ${listed(lists.map((l) => l.name), limit)}`,
    );
    longLists.push({ name: 'things', count: lists.length });
  }
  for (const entry of lists) {
    if (entry.functions.length > limit) {
      notes.push(
        `\`${entry.name}\` shows ${counted(entry.functions.length, 'function')}: ${listed(entry.functions, limit)}`,
      );
      longLists.push({ name: entry.name, count: entry.functions.length });
    }
  }
  return { notes, longLists };
}
