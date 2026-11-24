/**
 * `field-leak`: external code that mutates, indexes, or calls mutating methods
 * on a field of a class/type it is not part of — directly or through a trivial
 * getter, setter, or forwarder.
 *
 * A type guards its fields when it keeps at least one non-marker field private
 * to itself and has at least one instance method working on its fields.
 * Plain value reads (primitives / readonly snapshots) are not leaks.
 */

import type { SemanticGraph, SemanticUse, ThingId } from '../model/graph.ts';
import type {
  Diagnostic,
  ItemId,
  Location,
  Model,
  NodeId,
  TruelineConfig,
} from '../model/types.ts';
import {
  clickable,
  compareSite,
  counted,
  inScope,
  listed,
  stripGenerics,
} from './helpers.ts';

export function checkFieldLeaks(
  model: Model,
  graph: SemanticGraph,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const fieldsByThing = new Map<ThingId, ItemId[]>();
  for (let id = 0; id < model.items.length; id += 1) {
    const item = model.items[id]!;
    if (item.kind !== 'field' || item.holdsNothing) continue;
    if (
      item.parent === undefined ||
      model.items[item.parent]?.kind !== 'type'
    ) {
      continue;
    }
    const thing = graph.thingOf[id];
    if (thing === undefined) continue;
    let list = fieldsByThing.get(thing);
    if (list === undefined) {
      list = [];
      fieldsByThing.set(thing, list);
    }
    list.push(id);
  }

  const outside = new Map<ItemId, SemanticUse[]>();
  const working = new Set<ThingId>();

  for (const usage of graph.uses) {
    const field = model.items[usage.item];
    if (field === undefined || field.kind !== 'field') continue;
    const owner = graph.thingOf[usage.item];
    if (owner === undefined) continue;

    const ownerTangle = graph.tangleOf[owner];
    const isInsider =
      usage.user !== undefined &&
      (usage.user === owner ||
        (ownerTangle !== undefined && graph.tangleOf[usage.user] === ownerTangle));

    if (!isInsider) {
      let list = outside.get(usage.item);
      if (list === undefined) {
        list = [];
        outside.set(usage.item, list);
      }
      list.push(usage);
    } else if (usage.user === owner && isWorkingMethod(model, usage)) {
      working.add(owner);
    }
  }

  const diagnostics: Diagnostic[] = [];
  for (const [thing, fields] of fieldsByThing) {
    const hasKeptField = fields.some((f) => !outside.has(f));
    if (!hasKeptField || !working.has(thing)) continue;

    for (const field of fields) {
      const leakingUses = (outside.get(field) ?? []).filter((u) => !u.copies);
      if (leakingUses.length === 0) continue;

      const home = graph.things[thing]!.home;
      const concerned =
        inScope(model.tree, scope, home) ||
        leakingUses.some((u) =>
          inScope(model.tree, scope, model.references[u.referenceIndex]!.from),
        );
      if (!concerned) continue;

      diagnostics.push(
        buildLeakDiagnostic(model, graph, config, thing, field, fields, outside, leakingUses),
      );
    }
  }

  return diagnostics;
}

function isWorkingMethod(model: Model, usage: SemanticUse): boolean {
  const holderId = model.references[usage.referenceIndex]?.holder;
  if (holderId === undefined) return false;
  const holder = model.items[holderId];
  return (
    holder !== undefined &&
    holder.kind === 'function' &&
    holder.takesSelf &&
    !model.wrappers.has(holderId)
  );
}

function bareFieldName(model: Model, field: ItemId): string {
  const name = model.items[field]?.name ?? '';
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

function buildLeakDiagnostic(
  model: Model,
  graph: SemanticGraph,
  config: TruelineConfig,
  thing: ThingId,
  field: ItemId,
  allFields: readonly ItemId[],
  outside: ReadonlyMap<ItemId, readonly SemanticUse[]>,
  uses: readonly SemanticUse[],
): Diagnostic {
  const tree = model.tree;
  const siteMap = new Map<string, { loc: Location; desc: string }>();
  const placesByModule = new Map<NodeId, Set<string>>();

  for (const usage of uses) {
    const ref = model.references[usage.referenceIndex]!;
    const file = model.files[ref.file];
    if (file === undefined) continue;

    const holderDesc =
      ref.holder !== undefined
        ? `${tree.node(model.items[ref.holder]!.owner).displayPath}:${stripGenerics(model.items[ref.holder]!.name)}`
        : tree.node(ref.from).displayPath;
    const throughDesc =
      usage.through !== undefined
        ? `, through \`${stripGenerics(model.items[usage.through]!.name)}\``
        : '';

    const loc: Location = { file: file.path, line: ref.line, column: ref.column };
    const siteKey = clickable(loc);
    if (!siteMap.has(siteKey)) {
      siteMap.set(siteKey, { loc, desc: `\`${holderDesc}\`${throughDesc}` });
    }
    let modPlaces = placesByModule.get(ref.from);
    if (modPlaces === undefined) {
      modPlaces = new Set();
      placesByModule.set(ref.from, modPlaces);
    }
    modPlaces.add(siteKey);
  }

  const sites = [...siteMap.values()].sort((a, b) => compareSite(a.loc, b.loc));
  const notes = sites
    .slice(0, config.heldInMind)
    .map((s) => `${clickable(s.loc)}: ${s.desc}`);
  if (sites.length > config.heldInMind) {
    notes.push(`and ${counted(sites.length - config.heldInMind, 'more place')}`);
  }

  const modules = [...placesByModule.entries()]
    .map(([mod, set]) => ({ count: set.size, name: tree.node(mod).displayPath }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const totalModules = modules.length;
  const shownModules =
    modules.length > config.heldInMind
      ? [
          ...modules.slice(0, config.heldInMind),
          {
            count: modules
              .slice(config.heldInMind)
              .reduce((sum, m) => sum + m.count, 0),
            name: `in ${counted(modules.length - config.heldInMind, 'more module')}`,
          },
        ]
      : modules;

  const knownOutside: string[] = [];
  const kept: string[] = [];
  for (const other of allFields) {
    if (other === field) continue;
    const otherUses = outside.get(other);
    if (otherUses === undefined) {
      kept.push(bareFieldName(model, other));
    } else if (otherUses.some((u) => !u.copies)) {
      knownOutside.push(bareFieldName(model, other));
    }
  }
  const others: string[] = [];
  if (knownOutside.length > 0) {
    others.push(`also known outside: ${listed(knownOutside, config.heldInMind)}`);
  }
  if (kept.length > 0) {
    others.push(`kept: ${listed(kept, config.heldInMind)}`);
  }

  const ownerThing = graph.things[thing]!;
  const typeName = stripGenerics(model.items[ownerThing.item]!.name);
  const fieldName = model.items[field]!.name;
  const ownerDisplay = tree.node(ownerThing.home).displayPath;

  return {
    lint: 'field-leak',
    key: `${ownerDisplay}:${fieldName}`,
    message: `\`${fieldName}\` is known outside \`${typeName}\`: ${counted(sites.length, 'place')} in ${counted(totalModules, 'module')}`,
    location: sites[0]?.loc,
    notes,
    picture: {
      kind: 'spread',
      owner: `${ownerDisplay}:${typeName}`,
      field: bareFieldName(model, field),
      modules: shownModules,
      others,
    },
  };
}
