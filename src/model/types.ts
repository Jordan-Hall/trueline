/**
 * Pure domain model for trueline.
 *
 * Represents a workspace's module hierarchy, source files, semantic items,
 * resolved references, import edges, wrapper functions, code-hygiene findings,
 * structural clones, configuration, and structured diagnostics.
 */

export const ARCH_LINTS = [
  'module-cycle',
  'package-cycle',
  'tangle',
  'field-leak',
  'shallow-module',
  'wide-directory',
  'long-file',
  'layer-violation',
  'undeclared-dep',
  'unused-export',
  'wildcard-barrel',
] as const;

export const SLOP_LINTS = [
  'verbose-comment',
  'dead-code',
  'silent-catch',
  'type-escape',
  'pass-through',
  'complex-function',
  'duplicate-logic',
] as const;

export const ALL_LINTS = [...ARCH_LINTS, ...SLOP_LINTS] as const;

export type LintKind = (typeof ALL_LINTS)[number];
export type PresetKind = 'all' | 'arch' | 'slop' | 'strict';

export function isLintKind(value: string): value is LintKind {
  return (ALL_LINTS as readonly string[]).includes(value);
}

export type NodeId = number;
export type FileId = number;
export type ItemId = number;

export type NodeKind = 'workspace' | 'package' | 'module';

export interface TreeNode {
  readonly id: NodeId;
  readonly kind: NodeKind;
  readonly name: string;
  readonly displayPath: string;
  readonly parent: NodeId | undefined;
  readonly packageId: NodeId | undefined;
  readonly isTest: boolean;
  readonly dirPath: string | undefined;
  readonly packageName: string | undefined;
  readonly declaredDeps: readonly string[];
}

/**
 * Hierarchical tree of Workspace -> Package -> Module nodes.
 * Exposes a narrow high-level query interface while keeping traversal internals private.
 */
export class ModuleTree {
  readonly rootId: NodeId = 0;
  readonly #nodes: TreeNode[] = [];
  readonly #children = new Map<string, NodeId>();

  constructor() {
    this.#nodes.push({
      id: 0,
      kind: 'workspace',
      name: '',
      displayPath: '',
      parent: undefined,
      packageId: undefined,
      isTest: false,
      dirPath: '',
      packageName: undefined,
      declaredDeps: [],
    });
  }

  node(id: NodeId): TreeNode {
    const found = this.#nodes[id];
    if (found === undefined) {
      throw new RangeError(`Unknown NodeId ${id}`);
    }
    return found;
  }

  child(
    parent: NodeId,
    kind: NodeKind,
    name: string,
    meta?: {
      dirPath?: string;
      packageName?: string;
      declaredDeps?: readonly string[];
    },
  ): NodeId {
    const key = `${parent}\0${name}`;
    const existing = this.#children.get(key);
    if (existing !== undefined) return existing;
    const id = this.#nodes.length;
    const parentNode = this.node(parent);
    const packageId = kind === 'package' ? id : parentNode.packageId;
    const isTest = parentNode.isTest || isTestSegment(name);
    const displayPath =
      parentNode.displayPath.length === 0
        ? name
        : `${parentNode.displayPath}/${name}`;
    this.#nodes.push({
      id,
      kind,
      name,
      displayPath,
      parent,
      packageId,
      isTest,
      dirPath: meta?.dirPath,
      packageName: meta?.packageName,
      declaredDeps: meta?.declaredDeps ?? [],
    });
    this.#children.set(key, id);
    return id;
  }

  isWithin(nodeId: NodeId, ancestor: NodeId): boolean {
    let current: NodeId | undefined = nodeId;
    while (current !== undefined) {
      if (current === ancestor) return true;
      current = this.node(current).parent;
    }
    return false;
  }

  siblingPair(
    a: NodeId,
    b: NodeId,
  ): { readonly parent: NodeId; readonly user: NodeId; readonly used: NodeId } | undefined {
    const parent = this.#commonAncestor(a, b);
    if (parent === a || parent === b) return undefined;
    if (this.node(parent).kind === 'workspace') return undefined;
    const user = this.#directChildUnder(a, parent);
    const used = this.#directChildUnder(b, parent);
    if (user === undefined || used === undefined || user === used) {
      return undefined;
    }
    return { parent, user, used };
  }

  scopeChain(nodeId: NodeId): NodeId[] {
    const pkg = this.node(nodeId).packageId;
    const out: NodeId[] = [];
    for (const ancestor of this.#ancestors(nodeId)) {
      const n = this.node(ancestor);
      if (n.kind === 'workspace' || n.packageId !== pkg) break;
      out.push(ancestor);
    }
    return out;
  }

  query(spec?: string): NodeId[] {
    if (spec !== undefined) {
      const normalized = spec.replaceAll('\\', '/').replace(/\/+$/, '');
      for (const n of this.#nodes) {
        if (n.kind === 'workspace') continue;
        if (
          n.packageName === normalized ||
          n.dirPath === normalized ||
          n.displayPath === normalized ||
          n.name === normalized
        ) {
          return [n.id];
        }
      }
      return [];
    }

    const parentsWithNonTestChild = new Set<NodeId>();
    for (const n of this.#nodes) {
      if (!n.isTest && n.parent !== undefined) {
        parentsWithNonTestChild.add(n.parent);
      }
    }
    const out: NodeId[] = [];
    for (const n of this.#nodes) {
      if (n.isTest) continue;
      if (
        n.kind === 'package' ||
        (n.kind === 'module' && parentsWithNonTestChild.has(n.id))
      ) {
        out.push(n.id);
      }
    }
    return out;
  }

  #ancestors(id: NodeId): NodeId[] {
    const chain: NodeId[] = [];
    let current: NodeId | undefined = id;
    while (current !== undefined) {
      chain.push(current);
      current = this.node(current).parent;
    }
    return chain;
  }

  #commonAncestor(a: NodeId, b: NodeId): NodeId {
    const ancestorsOfA = new Set(this.#ancestors(a));
    for (const candidate of this.#ancestors(b)) {
      if (ancestorsOfA.has(candidate)) return candidate;
    }
    return this.rootId;
  }

  #directChildUnder(of: NodeId, parent: NodeId): NodeId | undefined {
    for (const node of this.#ancestors(of)) {
      if (this.node(node).parent === parent) return node;
    }
    return undefined;
  }
}

function isTestSegment(name: string): boolean {
  return (
    name === '__tests__' ||
    name === 'tests' ||
    name === 'test' ||
    name === 'e2e' ||
    name.endsWith('.test') ||
    name.endsWith('.spec')
  );
}

export interface FileInfo {
  readonly id: FileId;
  readonly path: string;
  readonly packageNode: NodeId;
  readonly moduleNode: NodeId;
  readonly isTest: boolean;
  readonly isEntrypoint: boolean;
  readonly lines: number;
}

export type ItemKind =
  | 'module'
  | 'type'
  | 'function'
  | 'field'
  | 'constant'
  | 'other';

export interface Item {
  readonly id: ItemId;
  readonly name: string;
  readonly owner: NodeId;
  readonly file: FileId | undefined;
  readonly line: number;
  readonly kind: ItemKind;
  readonly parent: ItemId | undefined;
  readonly exported: boolean;
  readonly takesSelf: boolean;
  readonly isLifecycle: boolean;
  readonly holdsNothing: boolean;
}

export interface Reference {
  readonly file: FileId;
  readonly line: number;
  readonly column: number;
  readonly from: NodeId;
  readonly holder: ItemId | undefined;
  readonly item: ItemId;
  readonly copies: boolean;
  readonly typeOnly: boolean;
  readonly isTest: boolean;
}

export interface FileImport {
  readonly file: FileId;
  readonly line: number;
  readonly column: number;
  readonly fromModule: NodeId;
  readonly fromPackage: NodeId;
  readonly specifier: string;
  readonly targetFile: FileId | undefined;
  readonly targetModule: NodeId | undefined;
  readonly targetPackage: NodeId | undefined;
  readonly symbols: readonly string[];
  readonly typeOnly: boolean;
  readonly isWildcardReExport: boolean;
  readonly isTest: boolean;
}

export type Wrapper =
  | {
      readonly kind: 'forwarder';
      readonly target: ItemId;
      readonly fields: readonly ItemId[];
    }
  | {
      readonly kind: 'accessor';
      readonly lent: readonly ItemId[];
      readonly copied: readonly ItemId[];
      readonly toRead: boolean;
    };

export type TextSlopKind =
  | 'verbose-comment'
  | 'dead-code'
  | 'silent-catch'
  | 'type-escape';

export interface SlopFinding {
  readonly lint: TextSlopKind;
  readonly file: FileId;
  readonly line: number;
  readonly column: number;
  readonly rule: string;
  readonly detail: string;
  readonly isTest: boolean;
}

export interface FunctionMetric {
  readonly file: FileId;
  readonly line: number;
  readonly column: number;
  readonly name: string;
  readonly lines: number;
  readonly maxNesting: number;
  readonly paramCount: number;
  readonly tokenCount: number;
  readonly fingerprint: string | undefined;
  readonly isTest: boolean;
}

export interface Model {
  readonly tree: ModuleTree;
  readonly files: FileInfo[];
  readonly items: Item[];
  readonly references: Reference[];
  readonly imports: FileImport[];
  readonly wrappers: Map<ItemId, Wrapper>;
  readonly slopFindings: SlopFinding[];
  readonly functions: FunctionMetric[];
}

export interface Location {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface CycleStep {
  readonly member: string;
  readonly site: Location;
  readonly uses: string;
}

export type Picture =
  | {
      readonly kind: 'circle';
      readonly steps: readonly CycleStep[];
      readonly rest: string | undefined;
    }
  | {
      readonly kind: 'spread';
      readonly owner: string;
      readonly field: string;
      readonly modules: readonly { readonly count: number; readonly name: string }[];
      readonly others: readonly string[];
    }
  | {
      readonly kind: 'lists';
      readonly shown: number;
      readonly hidden: number;
      readonly lists: readonly { readonly name: string; readonly count: number }[];
      readonly limit: number;
    }
  | {
      readonly kind: 'bar';
      readonly label: string;
      readonly length: number;
      readonly most: number;
    }
  | {
      readonly kind: 'boundary';
      readonly ruleName: string;
      readonly fromLabel: string;
      readonly toLabel: string;
      readonly edges: readonly { readonly site: Location; readonly detail: string }[];
      readonly reason: string | undefined;
    };

export interface Diagnostic {
  readonly lint: LintKind;
  readonly key: string;
  readonly message: string;
  readonly location: Location | undefined;
  readonly notes: readonly string[];
  readonly picture: Picture;
}

export interface LayerRule {
  readonly name: string;
  readonly from: string | readonly string[];
  readonly deny?: readonly string[];
  readonly allow?: readonly string[];
  readonly reason?: string;
  readonly ignoreTypeOnly?: boolean;
}

export interface LayerConfig {
  readonly preset: 'clean-architecture' | 'none';
  readonly noPackageToApp: boolean;
  readonly featureSlices: readonly string[];
  readonly rules: readonly LayerRule[];
}

export interface PreprocessorRule {
  readonly replace: readonly (readonly [string, string])[];
  readonly scriptKind?: 'ts' | 'tsx' | 'js' | 'jsx';
}

export interface GithubGovernanceConfig {
  readonly ratchet: 'merge' | 'manual';
  readonly branch: string;
  readonly bot?: string;
  readonly protect: readonly string[];
}

export interface TruelineConfig {
  readonly heldInMind: number;
  readonly breakEven: number;
  readonly maxDirectoryMembers: number;
  readonly maxFileLines: number;
  readonly maxFunctionLines: number;
  readonly maxNestingDepth: number;
  readonly maxParameters: number;
  readonly minCloneTokens: number;
  readonly ignoreTypeOnlyImports: boolean;
  readonly ignore: readonly string[];
  readonly extensions: readonly string[];
  readonly preprocessors: Readonly<Record<string, PreprocessorRule>>;
  readonly lints: Readonly<Record<LintKind, boolean>>;
  readonly layers: LayerConfig;
  readonly github?: GithubGovernanceConfig;
}

export interface RustCrateReport {
  readonly name: string;
  readonly relDir: string;
  readonly errorCount: number;
  readonly byLint: Readonly<Record<string, number>>;
  readonly status: 'ok' | 'errors' | 'unavailable';
  readonly note?: string;
}

export interface ReportStats {
  readonly totalPackages: number;
  readonly packagesAnalyzed: number;
  readonly packagesFromCache: number;
  readonly files: number;
  readonly items: number;
  readonly references: number;
  readonly imports: number;
  readonly elapsedMs: number;
}

export interface BaselineSnapshot {
  readonly label: string;
  readonly total: number;
  readonly byLint: Readonly<Record<string, number>>;
}

export interface ReportContext {
  readonly projectName: string;
  readonly stats?: ReportStats;
  readonly allowPath?: string;
  readonly suppressedCount?: number;
  readonly fixedAllowed?: number;
  readonly totalBeforeAllow?: number;
  readonly configuredFamilyRules?: number;
  readonly rustCrates?: readonly RustCrateReport[];
  readonly allDiagnostics?: readonly Diagnostic[];
  readonly baseline?: BaselineSnapshot;
}

export const DEFAULT_CONFIG: TruelineConfig = {
  heldInMind: 7,
  breakEven: 1,
  maxDirectoryMembers: 15,
  maxFileLines: 1500,
  maxFunctionLines: 120,
  maxNestingDepth: 4,
  maxParameters: 5,
  minCloneTokens: 45,
  ignoreTypeOnlyImports: false,
  ignore: [
    '**/node_modules/**',
    '**/dist/**',
    '**/dist-server/**',
    '**/build/**',
    '**/.turbo/**',
    '**/.next/**',
    '**/.rslib/**',
    '**/.rspress/**',
    '**/target/**',
    '**/coverage/**',
    '**/generated/**',
    '**/*.generated.*',
    '**/*.d.ts',
    '**/*.d.mts',
    '**/*.d.cts',
  ],
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  preprocessors: {},
  lints: {
    'module-cycle': true,
    'package-cycle': true,
    tangle: true,
    'field-leak': true,
    'shallow-module': true,
    'wide-directory': true,
    'long-file': true,
    'layer-violation': true,
    'undeclared-dep': true,
    'unused-export': true,
    'wildcard-barrel': true,
    'verbose-comment': true,
    'dead-code': true,
    'silent-catch': true,
    'type-escape': true,
    'pass-through': true,
    'complex-function': true,
    'duplicate-logic': true,
  },
  layers: {
    preset: 'clean-architecture',
    noPackageToApp: true,
    featureSlices: [],
    rules: [],
  },
};

export function createEmptyModel(): Model {
  return {
    tree: new ModuleTree(),
    files: [],
    items: [],
    references: [],
    imports: [],
    wrappers: new Map(),
    slopFindings: [],
    functions: [],
  };
}
