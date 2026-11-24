/**
 * Semantic dependency graph built from a Model.
 *
 * Groups items into `Thing`s (a class/type together with its fields and
 * methods, or a free function/constant), pierces wrapper functions (forwarders
 * and accessors), and finds strongly connected components via Tarjan's
 * algorithm.
 */

import type { ItemId, Model, NodeId, Reference } from './types.ts';

export type ThingId = number;
export type TangleId = number;

export interface Thing {
  readonly id: ThingId;
  readonly item: ItemId;
  readonly home: NodeId;
}

export interface SemanticUse {
  readonly referenceIndex: number;
  readonly user: ThingId | undefined;
  readonly item: ItemId;
  readonly through: ItemId | undefined;
  readonly copies: boolean;
}

export interface SemanticGraph {
  readonly things: readonly Thing[];
  readonly thingOf: readonly (ThingId | undefined)[];
  readonly uses: readonly SemanticUse[];
  readonly tangles: readonly (readonly ThingId[])[];
  readonly tangleOf: readonly (TangleId | undefined)[];
}

/**
 * Strongly connected components of size >= 2 in a directed graph, using
 * iterative Tarjan's algorithm so deep graphs never overflow the JS stack.
 * Each component is sorted ascending and the list of components is sorted.
 */
export function findCircles(adjacency: readonly (readonly number[])[]): number[][] {
  const n = adjacency.length;
  const index = new Int32Array(n).fill(-1);
  const lowlink = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const components: number[][] = [];
  let nextIndex = 0;

  for (let start = 0; start < n; start += 1) {
    if (index[start] !== -1) continue;
    nextIndex = tarjanTraverse(
      start,
      adjacency,
      index,
      lowlink,
      onStack,
      stack,
      components,
      nextIndex,
    );
  }

  components.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  return components;
}

function tarjanTraverse(
  start: number,
  adjacency: readonly (readonly number[])[],
  index: Int32Array,
  lowlink: Int32Array,
  onStack: Uint8Array,
  stack: number[],
  components: number[][],
  nextIndex: number,
): number {
  const callStack: { node: number; edgePos: number }[] = [
    { node: start, edgePos: 0 },
  ];
  index[start] = nextIndex;
  lowlink[start] = nextIndex;
  let seq = nextIndex + 1;
  stack.push(start);
  onStack[start] = 1;

  while (callStack.length > 0) {
    const frame = callStack[callStack.length - 1]!;
    const neighbours = adjacency[frame.node] ?? [];

    if (frame.edgePos < neighbours.length) {
      const next = neighbours[frame.edgePos]!;
      frame.edgePos += 1;
      if (index[next] === -1) {
        index[next] = seq;
        lowlink[next] = seq;
        seq += 1;
        stack.push(next);
        onStack[next] = 1;
        callStack.push({ node: next, edgePos: 0 });
      } else if (onStack[next] === 1 && index[next]! < lowlink[frame.node]!) {
        lowlink[frame.node] = index[next]!;
      }
      continue;
    }

    callStack.pop();
    if (callStack.length > 0) {
      const parent = callStack[callStack.length - 1]!.node;
      if (lowlink[frame.node]! < lowlink[parent]!) {
        lowlink[parent] = lowlink[frame.node]!;
      }
    }
    if (lowlink[frame.node] === index[frame.node]) {
      const component: number[] = [];
      let member = -1;
      while (member !== frame.node) {
        member = stack.pop()!;
        onStack[member] = 0;
        component.push(member);
      }
      if (component.length >= 2) {
        component.sort((a, b) => a - b);
        components.push(component);
      }
    }
  }

  return seq;
}

export function buildSemanticGraph(
  model: Model,
  options?: { readonly ignoreTypeOnly?: boolean },
): SemanticGraph {
  const ignoreTypeOnly = options?.ignoreTypeOnly ?? false;
  const { things, thingOf } = collectThings(model);
  const uses = collectUses(model, thingOf, ignoreTypeOnly);

  const knows: number[][] = Array.from({ length: things.length }, () => []);
  const edgeSeen = new Set<string>();
  for (const usage of uses) {
    if (usage.user === undefined) continue;
    const used = thingOf[usage.item];
    if (used === undefined || used === usage.user) continue;
    const edgeKey = `${usage.user}:${used}`;
    if (edgeSeen.has(edgeKey)) continue;
    edgeSeen.add(edgeKey);
    knows[usage.user]!.push(used);
  }

  const tangles = findCircles(knows);
  const tangleOf: (TangleId | undefined)[] = Array.from(
    { length: things.length },
    () => undefined,
  );
  for (let tangleId = 0; tangleId < tangles.length; tangleId += 1) {
    for (const member of tangles[tangleId]!) {
      tangleOf[member] = tangleId;
    }
  }

  return { things, thingOf, uses, tangles, tangleOf };
}

function collectThings(model: Model): {
  things: Thing[];
  thingOf: (ThingId | undefined)[];
} {
  const isCounted = (id: ItemId): boolean => {
    const item = model.items[id];
    if (item === undefined) return false;
    if (item.kind === 'module') return false;
    if (model.tree.node(item.owner).isTest) return false;
    if (item.file !== undefined && model.files[item.file]?.isTest) return false;
    return true;
  };

  const things: Thing[] = [];
  const ofRoot: (ThingId | undefined)[] = Array.from(
    { length: model.items.length },
    () => undefined,
  );
  const thingOf: (ThingId | undefined)[] = Array.from(
    { length: model.items.length },
    () => undefined,
  );

  for (let id = 0; id < model.items.length; id += 1) {
    let root = id;
    const visited = new Set<ItemId>();
    while (true) {
      const parent = model.items[root]?.parent;
      if (parent === undefined || visited.has(parent)) break;
      visited.add(root);
      root = parent;
    }

    const rootItem = model.items[root];
    if (rootItem === undefined) continue;
    const isThing =
      rootItem.kind === 'type' ||
      rootItem.kind === 'function' ||
      rootItem.kind === 'constant';
    if (!isThing || !isCounted(id) || !isCounted(root)) continue;

    let thingId = ofRoot[root];
    if (thingId === undefined) {
      thingId = things.length;
      things.push({ id: thingId, item: root, home: rootItem.owner });
      ofRoot[root] = thingId;
    }
    thingOf[id] = thingId;
  }

  return { things, thingOf };
}

function collectUses(
  model: Model,
  thingOf: readonly (ThingId | undefined)[],
  ignoreTypeOnly: boolean,
): SemanticUse[] {
  const uses: SemanticUse[] = [];
  for (let refIdx = 0; refIdx < model.references.length; refIdx += 1) {
    const reference = model.references[refIdx]!;
    if (reference.isTest) continue;
    if (ignoreTypeOnly && reference.typeOnly) continue;
    if (reference.holder !== undefined && model.wrappers.has(reference.holder)) {
      continue;
    }

    const user =
      reference.holder !== undefined ? thingOf[reference.holder] : undefined;
    const through = model.wrappers.has(reference.item)
      ? reference.item
      : undefined;

    for (const [targetItem, copies] of resolveBehindWrappers(model, reference)) {
      if (thingOf[targetItem] !== undefined) {
        uses.push({
          referenceIndex: refIdx,
          user,
          item: targetItem,
          through,
          copies,
        });
      }
    }
  }
  return uses;
}

/**
 * Unwraps chains of forwarders and accessors so callers are attributed to
 * what actually sits behind trivial wrappers.
 */
function resolveBehindWrappers(
  model: Model,
  reference: Reference,
): [ItemId, boolean][] {
  const used: [ItemId, boolean][] = [];
  const visited = new Set<ItemId>();
  let current = reference.item;

  while (true) {
    if (visited.has(current)) {
      used.push([current, current === reference.item && reference.copies]);
      return used;
    }
    visited.add(current);

    const wrapper = model.wrappers.get(current);
    if (wrapper === undefined) {
      const direct = current === reference.item;
      used.push([current, direct && reference.copies]);
      return used;
    }

    if (wrapper.kind === 'forwarder') {
      for (const field of wrapper.fields) {
        used.push([field, true]);
      }
      current = wrapper.target;
    } else {
      for (const field of wrapper.lent) {
        used.push([field, wrapper.toRead && reference.copies]);
      }
      for (const field of wrapper.copied) {
        used.push([field, true]);
      }
      return used;
    }
  }
}
