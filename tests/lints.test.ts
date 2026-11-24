import { describe, expect, test } from 'bun:test';
import { runLints } from '../src/lint/index.ts';
import {
  createEmptyModel,
  DEFAULT_CONFIG,
  type ItemId,
  type ItemKind,
  type Model,
  type NodeId,
  type TruelineConfig,
} from '../src/model/types.ts';

class SampleBuilder {
  readonly model: Model = createEmptyModel();
  readonly pkg: NodeId;

  constructor(pkgName = 'p', pkgDir = 'packages/p') {
    this.pkg = this.model.tree.child(this.model.tree.rootId, 'package', pkgName, {
      dirPath: pkgDir,
      packageName: pkgName,
    });
  }

  addPackage(name: string, dirPath: string): NodeId {
    return this.model.tree.child(this.model.tree.rootId, 'package', name, {
      dirPath,
      packageName: name,
    });
  }

  module(path: string, pkgNode: NodeId = this.pkg): NodeId {
    let node = pkgNode;
    for (const seg of path.split('/').filter(Boolean)) {
      node = this.model.tree.child(node, 'module', seg);
    }
    if (!this.model.files.some((f) => f.moduleNode === node)) {
      const pkgDir = this.model.tree.node(pkgNode).dirPath ?? '';
      const prefix = pkgDir.length > 0 ? `${pkgDir}/src/` : 'src/';
      this.model.files.push({
        id: this.model.files.length,
        path: `${prefix}${path || 'index'}.ts`,
        packageNode: pkgNode,
        moduleNode: node,
        isTest: false,
        isEntrypoint: path === '' || path === 'index',
        lines: 10,
      });
    }
    return node;
  }

  file(moduleNode: NodeId, path: string, lines = 10, isTest = false): number {
    const id = this.model.files.length;
    this.model.files.push({
      id,
      path,
      packageNode: this.model.tree.node(moduleNode).packageId ?? this.pkg,
      moduleNode,
      isTest,
      isEntrypoint: false,
      lines,
    });
    return id;
  }

  item(
    owner: NodeId,
    name: string,
    kind: ItemKind,
    opts?: {
      parent?: ItemId;
      takesSelf?: boolean;
      holdsNothing?: boolean;
      isLifecycle?: boolean;
      exported?: boolean;
    },
  ): ItemId {
    const file = this.model.files.find((f) => f.moduleNode === owner)?.id;
    const id = this.model.items.length;
    this.model.items.push({
      id,
      name,
      owner,
      file,
      line: id + 1,
      kind,
      parent: opts?.parent,
      exported: opts?.exported ?? true,
      takesSelf: opts?.takesSelf ?? false,
      isLifecycle: opts?.isLifecycle ?? false,
      holdsNothing: opts?.holdsNothing ?? false,
    });
    return id;
  }

  refer(holder: ItemId, target: ItemId, opts?: { copies?: boolean; typeOnly?: boolean }): void {
    const from = this.model.items[holder]!.owner;
    const file = this.model.files.find((f) => f.moduleNode === from)!.id;
    this.model.references.push({
      file,
      line: this.model.references.length + 1,
      column: 1,
      from,
      holder,
      item: target,
      copies: opts?.copies ?? false,
      typeOnly: opts?.typeOnly ?? false,
      isTest: false,
    });
  }

  addImport(fromFileId: number, toFileId: number, specifier: string, typeOnly = false): void {
    const from = this.model.files[fromFileId]!;
    const to = this.model.files[toFileId]!;
    this.model.imports.push({
      file: fromFileId,
      line: this.model.imports.length + 1,
      column: 1,
      fromModule: from.moduleNode,
      fromPackage: from.packageNode,
      specifier,
      targetFile: toFileId,
      targetModule: to.moduleNode,
      targetPackage: to.packageNode,
      symbols: ['sym'],
      typeOnly,
      isWildcardReExport: false,
      isTest: from.isTest,
    });
  }
}

describe('module-cycle & package-cycle', () => {
  test('detects sibling module cycle and skips parent-child', () => {
    const s = new SampleBuilder();
    const socket = s.module('socket');
    const kinds = s.module('kinds');
    const epoll = s.module('kinds/epoll');

    const open = s.item(socket, 'open', 'function');
    const limit = s.item(socket, 'LIMIT', 'constant');
    const stream = s.item(kinds, 'Stream', 'type');
    const fits = s.item(kinds, 'fits', 'function');
    const wait = s.item(epoll, 'wait', 'function');

    // Parent <-> child is fine
    s.refer(fits, wait);
    s.refer(wait, stream);
    s.refer(open, stream);
    expect(runLints(s.model, DEFAULT_CONFIG).filter((d) => d.lint === 'module-cycle')).toEqual([]);

    // Closing sibling cycle triggers module-cycle
    s.refer(fits, limit);
    const cycles = runLints(s.model, DEFAULT_CONFIG).filter((d) => d.lint === 'module-cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.key).toBe('p/kinds,p/socket');
    expect(cycles[0]!.picture.kind).toBe('circle');
  });

  test('detects cross-package cycle', () => {
    const s = new SampleBuilder('@acme/a', 'packages/a');
    const pkgB = s.addPackage('@acme/b', 'packages/b');
    const modA = s.module('index', s.pkg);
    const modB = s.module('index', pkgB);
    const fileA = s.model.files.find((f) => f.moduleNode === modA)!.id;
    const fileB = s.model.files.find((f) => f.moduleNode === modB)!.id;
    s.addImport(fileA, fileB, '@acme/b');
    s.addImport(fileB, fileA, '@acme/a');

    const pkgCycles = runLints(s.model, DEFAULT_CONFIG).filter((d) => d.lint === 'package-cycle');
    expect(pkgCycles).toHaveLength(1);
    expect(pkgCycles[0]!.key).toBe('@acme/a,@acme/b');
  });
});

describe('tangle', () => {
  test('flags two things across parent and child modules', () => {
    const s = new SampleBuilder();
    const kernel = s.module('kernel');
    const timers = s.module('kernel/timers');
    const tasks = s.item(kernel, 'Tasks', 'type');
    const timer = s.item(timers, 'Timers', 'type');
    const spawn = s.item(kernel, 'Tasks.spawn', 'function', { parent: tasks });
    const fire = s.item(timers, 'Timers.fire', 'function', { parent: timer });
    s.refer(spawn, timer);
    s.refer(fire, tasks);

    const tangles = runLints(s.model, DEFAULT_CONFIG).filter((d) => d.lint === 'tangle');
    expect(tangles).toHaveLength(1);
    expect(tangles[0]!.key).toBe('p/kernel/timers:Timers,p/kernel:Tasks');
  });

  test('allows single-module cycle of 7 things and flags 8', () => {
    const makeRing = (size: number) => {
      const s = new SampleBuilder();
      const mod = s.module('ring');
      const items = Array.from({ length: size }, (_, i) =>
        s.item(mod, `T${i}`, 'type'),
      );
      for (let i = 0; i < size; i += 1) {
        s.refer(items[i]!, items[(i + 1) % size]!);
      }
      return runLints(s.model, DEFAULT_CONFIG).filter((d) => d.lint === 'tangle');
    };
    expect(makeRing(7)).toHaveLength(0);
    expect(makeRing(8)).toHaveLength(1);
  });
});

describe('field-leak', () => {
  test('flags direct and getter-pierced mutations while permitting copy reads', () => {
    const s = new SampleBuilder();
    const queue = s.module('queue');
    const sched = s.module('sched');

    const rq = s.item(queue, 'RunQueue', 'type');
    const items = s.item(queue, 'RunQueue.items', 'field', { parent: rq });
    const head = s.item(queue, 'RunQueue.head', 'field', { parent: rq });
    const limit = s.item(queue, 'RunQueue.limit', 'field', { parent: rq });
    const full = s.item(queue, 'RunQueue.full', 'function', { parent: rq, takesSelf: true });
    s.refer(full, items);
    s.refer(full, head);
    s.refer(full, limit);

    const getItems = s.item(queue, 'RunQueue.getItems', 'function', { parent: rq, takesSelf: true });
    s.model.wrappers.set(getItems, {
      kind: 'accessor',
      lent: [items],
      copied: [],
      toRead: true,
    });

    const admit = s.item(sched, 'admit', 'function');
    // Reading head as a copy is safe
    s.refer(admit, head, { copies: true });
    expect(runLints(s.model, DEFAULT_CONFIG).filter((d) => d.lint === 'field-leak')).toEqual([]);

    // Mutating through getter leaks `items` (limit is kept!)
    s.refer(admit, getItems, { copies: false });
    const leaks = runLints(s.model, DEFAULT_CONFIG).filter((d) => d.lint === 'field-leak');
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.key).toBe('p/queue:RunQueue.items');
    expect(leaks[0]!.notes[0]).toContain('through `RunQueue.getItems`');
  });
});

describe('shallow-module', () => {
  test('flags module showing >7 with hidden <= shown and passes deep module', () => {
    const buildStore = (shownCount: number, hiddenCount: number) => {
      const s = new SampleBuilder();
      const store = s.module('store');
      s.module('store/table');
      const app = s.module('app');
      const cls = s.item(store, 'Store', 'type');
      const run = s.item(app, 'run', 'function');

      for (let i = 0; i < hiddenCount; i += 1) {
        s.item(store, `Store.helper${i}`, 'function', { parent: cls });
      }
      for (let i = 0; i < shownCount; i += 1) {
        const m = s.item(store, `Store.m${i}`, 'function', { parent: cls });
        s.refer(run, m);
      }
      return runLints(s.model, DEFAULT_CONFIG).filter((d) => d.lint === 'shallow-module');
    };

    expect(buildStore(7, 0)).toHaveLength(0);
    expect(buildStore(8, 9)).toHaveLength(0);
    expect(buildStore(8, 8).map((d) => d.key)).toEqual(['p/store']);
  });
});

describe('layout & layers', () => {
  test('flags wide-directory and long-file past thresholds', () => {
    const s = new SampleBuilder();
    const mod = s.module('big');
    for (let i = 0; i < 16; i += 1) {
      s.file(mod, `packages/p/src/big/f${i}.ts`, i === 0 ? 1501 : 10);
    }
    const diags = runLints(s.model, DEFAULT_CONFIG);
    expect(diags.filter((d) => d.lint === 'long-file')).toHaveLength(1);
    expect(diags.filter((d) => d.lint === 'wide-directory').map((d) => d.key)).toEqual([
      'packages/p/src/big/',
    ]);
  });

  test('enforces Clean Architecture preset, noPackageToApp, and featureSlices', () => {
    const s = new SampleBuilder('@acme/pkg', 'packages/pkg');
    const appPkg = s.addPackage('@acme/web', 'apps/web');

    const domMod = s.module('domain/order');
    const infraMod = s.module('infrastructure/db');
    const featAMod = s.module('features/billing/use');
    const featBInternal = s.module('features/auth/internal/token');
    const featBIndex = s.module('features/auth');
    const appMod = s.module('index', appPkg);

    const domFile = s.file(domMod, 'packages/pkg/src/domain/order.ts');
    const infraFile = s.file(infraMod, 'packages/pkg/src/infrastructure/db.ts');
    const featAFile = s.file(featAMod, 'packages/pkg/src/features/billing/use.ts');
    const featBInternalFile = s.file(
      featBInternal,
      'packages/pkg/src/features/auth/internal/token.ts',
    );
    const featBIndexFile = s.file(featBIndex, 'packages/pkg/src/features/auth/index.ts');
    const appFile = s.file(appMod, 'apps/web/src/index.ts');

    s.addImport(domFile, infraFile, '../infrastructure/db');
    s.addImport(infraFile, appFile, '@acme/web');
    s.addImport(featAFile, featBInternalFile, '../auth/internal/token');
    s.addImport(featAFile, featBIndexFile, '../auth');

    const config: TruelineConfig = {
      ...DEFAULT_CONFIG,
      layers: {
        ...DEFAULT_CONFIG.layers,
        featureSlices: ['packages/*/src/features/*'],
      },
    };
    const layerViolations = runLints(s.model, config).filter(
      (d) => d.lint === 'layer-violation',
    );
    expect(layerViolations.map((d) => d.key).sort()).toEqual([
      'clean-architecture:@acme/pkg:domain->infrastructure',
      'feature-slice:packages/pkg/src/features/billing->packages/pkg/src/features/auth:packages/pkg/src/features/auth/internal/token.ts',
      'no-package-to-app:@acme/pkg->@acme/web',
    ]);
  });
});
