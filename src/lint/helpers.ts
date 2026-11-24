/**
 * Shared pure utilities for lint rules: Tie aggregation, shortest-cycle search,
 * formatting helpers, and lightweight glob matching.
 */

import type { SemanticGraph, ThingId } from '../model/graph.ts';
import type {
  CycleStep,
  ItemId,
  Location,
  Model,
  ModuleTree,
  NodeId,
  Picture,
} from '../model/types.ts';

interface TieSite {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export class Tie {
  readonly items = new Set<ItemId>();
  readonly extraSymbols = new Set<string>();
  readonly holders = new Set<ItemId>();
  readonly sites = new Map<string, TieSite>();
  readonly written = new Map<NodeId, TieSite>();

  addRef(
    file: string,
    line: number,
    column: number,
    item: ItemId,
    holder: ItemId | undefined,
    moduleNode: NodeId,
  ): void {
    this.items.add(item);
    if (holder !== undefined) this.holders.add(holder);
    this.#recordSite(file, line, column, moduleNode);
  }

  addImportSymbol(
    file: string,
    line: number,
    column: number,
    symbol: string,
    moduleNode: NodeId,
  ): void {
    this.extraSymbols.add(symbol);
    this.#recordSite(file, line, column, moduleNode);
  }

  #recordSite(
    file: string,
    line: number,
    column: number,
    moduleNode: NodeId,
  ): void {
    const key = `${file}:${line}:${column}`;
    const site: TieSite = { file, line, column };
    if (!this.sites.has(key)) {
      this.sites.set(key, site);
    }
    const existing = this.written.get(moduleNode);
    if (existing === undefined || compareSite(site, existing) < 0) {
      this.written.set(moduleNode, site);
    }
  }

  cost(): number {
    return Math.max(1, this.items.size + this.extraSymbols.size);
  }

  firstSite(): Location {
    const sorted = [...this.sites.values()].sort(compareSite);
    const first = sorted[0];
    if (first === undefined) {
      return { file: '<unknown>', line: 1, column: 1 };
    }
    return first;
  }

  symbolNames(model: Model): string[] {
    const set = new Set<string>();
    for (const itemId of this.items) {
      const item = model.items[itemId];
      if (item !== undefined) set.add(stripGenerics(item.name));
    }
    for (const sym of this.extraSymbols) {
      set.add(sym);
    }
    return [...set].sort();
  }

  holderNames(model: Model): string[] {
    const set = new Set<string>();
    for (const holderId of this.holders) {
      const item = model.items[holderId];
      if (item !== undefined) set.add(stripGenerics(item.name));
    }
    return [...set].sort();
  }

  formatNote(
    model: Model,
    verb: string,
    user: string,
    used: string,
    limit: number,
  ): string {
    const site = this.firstSite();
    const elsewhere: string[] = [];
    const seenOther = new Set<string>();
    for (const other of [...this.written.values()].sort(compareSite)) {
      if (other.file === site.file && other.line === site.line) continue;
      const rendered = clickable(other);
      if (!seenOther.has(rendered)) {
        seenOther.add(rendered);
        elsewhere.push(rendered);
      }
    }
    const also =
      elsewhere.length > 0 ? `; also at ${listed(elsewhere, limit)}` : '';
    const symbols = this.symbolNames(model);
    const label = symbols.length > 0 ? listed(symbols, limit) : '(import)';
    return `${clickable(site)}: \`${user}\` ${verb} \`${used}\` by ${counted(this.cost(), 'item')}: ${label}${also}`;
  }

  toStep(model: Model, member: string, limit: number): CycleStep {
    const symbols = groupedNames(this.symbolNames(model), limit);
    const holders = this.holderNames(model);
    const uses =
      holders.length === 1
        ? `${holders[0]} uses ${symbols}`
        : `uses ${symbols}`;
    return {
      member,
      site: this.firstSite(),
      uses,
    };
  }
}

export function compareSite(a: TieSite, b: TieSite): number {
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  if (a.line !== b.line) return a.line - b.line;
  return a.column - b.column;
}

export function clickable(loc: Location): string {
  return `${loc.file}:${loc.line}:${loc.column}`;
}

export function counted(count: number, noun: string, plural?: string): string {
  if (count === 1) return `1 ${noun}`;
  return `${count} ${plural ?? `${noun}s`}`;
}

export function listed(names: readonly string[], limit: number): string {
  const shown = names.slice(0, limit).join(', ');
  const more = names.length - limit;
  return more > 0 ? `${shown}, +${more} more` : shown;
}

export function stripGenerics(name: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i]!;
    if (ch === '<') {
      depth += 1;
    } else if (ch === '>' && depth > 0) {
      depth -= 1;
    } else if (depth === 0) {
      out += ch;
    }
  }
  return out;
}

function groupedNames(names: readonly string[], limit: number): string {
  if (names.length === 0) return '(import)';
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const dot = name.indexOf('.');
    const head = dot === -1 ? name : name.slice(0, dot);
    const tail = dot === -1 ? 'self' : name.slice(dot + 1);
    const list = groups.get(head);
    if (list !== undefined) {
      if (!list.includes(tail)) list.push(tail);
    } else {
      groups.set(head, [tail]);
    }
  }
  const formatted: string[] = [];
  for (const [head, tails] of groups) {
    if (tails.length === 1 && tails[0] === 'self') {
      formatted.push(head);
    } else if (tails.length === 1) {
      formatted.push(`${head}.${tails[0]}`);
    } else {
      formatted.push(`${head}.{${listed(tails, limit)}}`);
    }
  }
  return listed(formatted, limit);
}

export function inScope(
  tree: ModuleTree,
  scope: NodeId | undefined,
  node: NodeId,
): boolean {
  return scope === undefined || tree.isWithin(node, scope);
}

export function fullThingName(
  model: Model,
  graph: SemanticGraph,
  thingId: ThingId,
): string {
  const thing = graph.things[thingId]!;
  const item = model.items[thing.item]!;
  const prefix = model.tree.node(thing.home).displayPath;
  const name = stripGenerics(item.name);
  return prefix.length > 0 ? `${prefix}:${name}` : name;
}

export function moduleLocation(
  model: Model,
  moduleNode: NodeId,
): Location | undefined {
  const candidates = model.files.filter(
    (f) => !f.isTest && model.tree.isWithin(f.moduleNode, moduleNode),
  );
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => {
    const rank = (path: string): number => {
      if (path.endsWith('/src/index.ts') || path === 'src/index.ts') return 0;
      if (
        path.endsWith('/index.ts') ||
        path.endsWith('/index.tsx') ||
        path.endsWith('/index.js')
      ) {
        return 1;
      }
      return 2;
    };
    const r = rank(a.path) - rank(b.path);
    return r !== 0 ? r : a.path.localeCompare(b.path);
  });
  return { file: candidates[0]!.path, line: 1, column: 1 };
}

export function circleReport(
  model: Model,
  verb: string,
  noun: string,
  memberCount: number,
  rawTies: readonly { readonly user: string; readonly used: string; readonly tie: Tie }[],
  limit: number,
): {
  readonly location: Location | undefined;
  readonly notes: string[];
  readonly picture: Picture;
} {
  const ties = [...rawTies].sort((a, b) => {
    const costDiff = a.tie.cost() - b.tie.cost();
    if (costDiff !== 0) return costDiff;
    if (a.user !== b.user) return a.user.localeCompare(b.user);
    return a.used.localeCompare(b.used);
  });

  const notes = ties
    .slice(0, limit)
    .map((entry) =>
      entry.tie.formatNote(model, verb, entry.user, entry.used, limit),
    );
  if (ties.length > limit) {
    notes.push(`and ${counted(ties.length - limit, 'more tie')}`);
  }

  const circleIndices = shortestCircle(ties);
  const steps = circleIndices.map((idx) => {
    const entry = ties[idx]!;
    return entry.tie.toStep(model, entry.user, limit);
  });

  const leftOut: string[] = [];
  if (memberCount > circleIndices.length) {
    leftOut.push(counted(memberCount - circleIndices.length, `more ${noun}`));
  }
  if (ties.length > circleIndices.length) {
    leftOut.push(counted(ties.length - circleIndices.length, 'more tie'));
  }

  return {
    location: ties[0]?.tie.firstSite(),
    notes,
    picture: {
      kind: 'circle',
      steps,
      rest:
        leftOut.length > 0 ? `not drawn: ${leftOut.join(', ')}` : undefined,
    },
  };
}

/**
 * BFS for the shortest cycle containing ties[0] (the cheapest tie to cut).
 */
function shortestCircle(
  ties: readonly { readonly user: string; readonly used: string }[],
): number[] {
  if (ties.length === 0) return [];
  const start = ties[0]!.user;
  const end = ties[0]!.used;

  const reached = new Map<string, number | undefined>([[end, undefined]]);
  const queue: string[] = [end];

  while (queue.length > 0) {
    const at = queue.shift()!;
    if (at === start) break;
    for (let idx = 0; idx < ties.length; idx += 1) {
      const edge = ties[idx]!;
      if (edge.user === at && !reached.has(edge.used)) {
        reached.set(edge.used, idx);
        queue.push(edge.used);
      }
    }
  }

  const circle: number[] = [];
  let cursor = start;
  const guard = new Set<string>();
  while (true) {
    if (guard.has(cursor)) break;
    guard.add(cursor);
    const via = reached.get(cursor);
    if (via === undefined) break;
    circle.push(via);
    cursor = ties[via]!.user;
  }
  circle.push(0);
  circle.reverse();
  return circle;
}

export { matchGlob } from '../model/glob.ts';
