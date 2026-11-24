/**
 * `tangle`: things (types, functions, constants) that mutually reference each
 * other in a cycle, written across more than one module OR larger than
 * `heldInMind` (default 7) even inside a single module.
 */

import type { SemanticGraph, ThingId } from '../model/graph.ts';
import type { Diagnostic, Model, NodeId, TruelineConfig } from '../model/types.ts';
import {
  circleReport,
  counted,
  fullThingName,
  inScope,
  listed,
  Tie,
} from './helpers.ts';

interface WrittenTangle {
  readonly modules: Set<NodeId>;
  readonly ties: Map<string, { user: ThingId; used: ThingId; tie: Tie }>;
}

export function checkTangles(
  model: Model,
  graph: SemanticGraph,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const written: WrittenTangle[] = graph.tangles.map((members) => ({
    modules: new Set(members.map((m) => graph.things[m]!.home)),
    ties: new Map(),
  }));

  for (const usage of graph.uses) {
    if (usage.user === undefined) continue;
    const used = graph.thingOf[usage.item];
    if (used === undefined || used === usage.user) continue;
    const tangleId = graph.tangleOf[usage.user];
    if (tangleId === undefined || graph.tangleOf[used] !== tangleId) continue;

    const ref = model.references[usage.referenceIndex]!;
    const file = model.files[ref.file];
    if (file === undefined) continue;

    const bucket = written[tangleId]!;
    bucket.modules.add(ref.from);
    const edgeKey = `${usage.user}:${used}`;
    let entry = bucket.ties.get(edgeKey);
    if (entry === undefined) {
      entry = { user: usage.user, used, tie: new Tie() };
      bucket.ties.set(edgeKey, entry);
    }
    entry.tie.addRef(
      file.path,
      ref.line,
      ref.column,
      usage.item,
      ref.holder,
      ref.from,
    );
  }

  const diagnostics: Diagnostic[] = [];
  for (let i = 0; i < written.length; i += 1) {
    const members = graph.tangles[i]!;
    const bucket = written[i]!;
    const concerned = members.some((m) =>
      inScope(model.tree, scope, graph.things[m]!.home),
    );
    if (!concerned) continue;
    if (bucket.modules.size <= 1 && members.length <= config.heldInMind) {
      continue;
    }

    const names = members
      .map((m) => fullThingName(model, graph, m))
      .sort();
    const ties = [...bucket.ties.values()].map((e) => ({
      user: fullThingName(model, graph, e.user),
      used: fullThingName(model, graph, e.used),
      tie: e.tie,
    }));

    const report = circleReport(
      model,
      'knows',
      'thing',
      members.length,
      ties,
      config.heldInMind,
    );
    const notes: string[] = [
      `members: ${listed(names, config.heldInMind)}`,
    ];
    if (bucket.modules.size > 1) {
      const modNames = [...bucket.modules]
        .map((m) => model.tree.node(m).displayPath)
        .sort();
      notes.push(`written in: ${listed(modNames, config.heldInMind)}`);
    }
    notes.push(...report.notes);

    const onlyMod =
      bucket.modules.size === 1 ? [...bucket.modules][0]! : undefined;
    const message =
      onlyMod !== undefined
        ? `${names.length} things know each other in a circle, all in \`${model.tree.node(onlyMod).displayPath}\``
        : `${names.length} things know each other in a circle, across ${counted(bucket.modules.size, 'module')}`;

    diagnostics.push({
      lint: 'tangle',
      key: names.join(','),
      message,
      location: report.location,
      notes,
      picture: report.picture,
    });
  }

  return diagnostics;
}
