/**
 * `--explain <lint>`: principle, rationale, and concise Before/After TypeScript
 * examples for every trueline rule.
 */

import type { LintKind } from '../model/types.ts';

interface LintGuide {
  readonly lint: LintKind;
  readonly pillar: 'architecture' | 'hygiene';
  readonly summary: string;
  readonly why: string;
  readonly fix: string;
  readonly before: string;
  readonly after: string;
}

const GUIDES: Readonly<Record<LintKind, LintGuide>> = {
  'module-cycle': {
    lint: 'module-cycle',
    pillar: 'architecture',
    summary: 'Sibling modules or directories import each other in a circle.',
    why: 'Cyclic modules cannot be understood, tested, or layered in a clear order, and trigger runtime TDZ/initialisation bugs.',
    fix: 'Inspect the cheapest tie highlighted in the diagram. Move the shared type or constant down to the lower-layer module, or extract a shared leaf module.',
    before: `// a.ts imports B from ./b; b.ts imports SharedConfig from ./a`,
    after: `// types.ts defines SharedConfig; both a.ts and b.ts import ./types (DAG)`,
  },
  'package-cycle': {
    lint: 'package-cycle',
    pillar: 'architecture',
    summary: 'Workspace packages depend on each other in a circular graph.',
    why: 'Breaks Turborepo/pnpm build ordering and forces coupled releases across package boundaries.',
    fix: 'Extract the shared contract into a lower-level package or invert the dependency through an interface.',
    before: `@org/router -> @org/ssr -> @org/router`,
    after: `@org/router-contract <- @org/router, @org/ssr`,
  },
  tangle: {
    lint: 'tangle',
    pillar: 'architecture',
    summary: 'Symbols mutually reference each other across >1 module or >7 symbols in one module.',
    why: 'Members of a tangle cannot be learned one at a time. Splitting files without breaking mutual references does not reduce cognitive load.',
    fix: 'Introduce a coordinator at a higher layer that calls both components, so neither knows the other.',
    before: `Tasks.spawn() calls Timers.schedule() AND Timers.fire() calls Tasks.wake()`,
    after: `Kernel.tick() polls Timers and passes ready IDs to Tasks.wake()`,
  },
  'field-leak': {
    lint: 'field-leak',
    pillar: 'architecture',
    summary: 'External code mutates or reaches into a field of a class that guards its own state.',
    why: 'Bypassing a class interface scatters invariant enforcement across callers, even when hidden behind a getter or setter.',
    fix: 'Move the state transition into a domain method on the owning class and return primitives or readonly views.',
    before: `queue.items.push(job); // or queue.getItems().push(job)`,
    after: `queue.enqueue(job);`,
  },
  'shallow-module': {
    lint: 'shallow-module',
    pillar: 'architecture',
    summary: 'A package or multi-file module exposes more than 7 functions while hiding no more than it shows.',
    why: 'From Ousterhout: when a module interface costs as much to learn as its internals, the boundary adds complexity instead of hiding it.',
    fix: 'Consolidate related operations behind a few cohesive high-level entrypoints and keep helpers internal.',
    before: `export { open, readHeader, parseChunk, validateChecksum, close, ...12 more }`,
    after: `export { loadArchive, saveArchive } // helpers stay internal`,
  },
  'wide-directory': {
    lint: 'wide-directory',
    pillar: 'architecture',
    summary: 'A directory holds more than maxDirectoryMembers (default 15) source files and folders.',
    why: 'Past ~15 entries, a directory listing is searched rather than comprehended at a glance.',
    fix: 'Group files into domain-named subdirectories rather than generic utils/ or lib/ drawers.',
    before: `src/routes/ (45 flat route files)`,
    after: `src/routes/{billing,users,reports}/`,
  },
  'long-file': {
    lint: 'long-file',
    pillar: 'architecture',
    summary: 'A source file exceeds maxFileLines (default 1500 lines).',
    why: 'Oversized files accumulate unrelated concerns and make code review and navigation slow.',
    fix: 'Split by cohesive domain sub-responsibility with a narrow interface between parts.',
    before: `src/routes/entries.ts (5,700 lines)`,
    after: `src/routes/entries/{query.ts, mutations.ts, export.ts}`,
  },
  'layer-violation': {
    lint: 'layer-violation',
    pillar: 'architecture',
    summary: 'An import crosses a forbidden Clean Architecture ring, package-family rule, or feature-slice internal boundary.',
    why: 'Dependencies must point inward (outer delivery/infra -> application -> domain) and across feature public entrypoints only.',
    fix: 'Depend on an interface/port owned by the inner layer, or import the sibling feature via its public index.ts.',
    before: `// src/domain/order.ts\nimport { saveRow } from '../infrastructure/db';`,
    after: `// src/domain/order.ts defines OrderRepository port; infrastructure implements it`,
  },
  'undeclared-dep': {
    lint: 'undeclared-dep',
    pillar: 'architecture',
    summary: 'A workspace package imports another workspace package without declaring it in package.json.',
    why: 'Phantom imports only resolve by hoisting accident and break under strict pnpm/Docker/Turborepo isolation.',
    fix: 'Add the dependency to package.json (or remove the import if it would introduce a cycle).',
    before: `// packages/web imports '@org/ui' without listing it in package.json`,
    after: `// packages/web/package.json: "dependencies": { "@org/ui": "workspace:*" }`,
  },
  'unused-export': {
    lint: 'unused-export',
    pillar: 'architecture',
    summary: 'An internal module exports a symbol that no other file in the workspace imports.',
    why: 'Speculative exports inflate module surfaces and hide which functions are actually safe to refactor.',
    fix: 'Drop the `export` keyword so the symbol stays module-private (or delete it if dead).',
    before: `export function formatInternalKey(id: string) { ... } // only used in this file`,
    after: `function formatInternalKey(id: string) { ... }`,
  },
  'wildcard-barrel': {
    lint: 'wildcard-barrel',
    pillar: 'architecture',
    summary: 'A module uses `export * from "..."` to re-export everything blindly.',
    why: 'Wildcard barrels obscure the public API surface, create accidental name collisions, and defeat tree-shaking.',
    fix: 'Replace `export *` with explicit named exports for the narrow public interface.',
    before: `export * from './internal-helpers';`,
    after: `export { parseConfig, type Config } from './config';`,
  },
  'verbose-comment': {
    lint: 'verbose-comment',
    pillar: 'hygiene',
    summary: 'ASCII divider banners, line-by-line narration comments, git-history prose, or >40% inline comment bloat.',
    why: 'Comments that restate what code already says rot quickly and drown out genuine invariant documentation.',
    fix: 'Delete narration, banners, and changelog comments. Keep concise comments that explain non-obvious invariants or why.',
    before: `// ========\n// Step 1: Increment the counter\ncount += 1;`,
    after: `count += 1;`,
  },
  'dead-code': {
    lint: 'dead-code',
    pillar: 'hygiene',
    summary: 'Commented-out code blocks (3+ lines), unimplemented stubs, `debugger`, or leftover `console.log`.',
    why: 'Dead code misleads readers, and unimplemented stubs silently blow up at runtime.',
    fix: 'Delete commented-out code (git keeps history), remove debug logs, and finish or remove stubs.',
    before: `// const old = fetchLegacy();\n// if (old) return old;\nconsole.log('here');`,
    after: `return fetchCurrent();`,
  },
  'silent-catch': {
    lint: 'silent-catch',
    pillar: 'hygiene',
    summary: 'An empty `catch {}` or silent fallback return inside `catch` with no logging, rethrow, or rationale.',
    why: 'Swallowing errors turns failures into mysterious downstream bugs.',
    fix: 'Handle or rethrow the error properly; if ignoring a specific expected error is intentional, document why.',
    before: `try { return JSON.parse(raw); } catch { return null; }`,
    after: `try { return JSON.parse(raw); } catch (err) { log.warn('Invalid cache', err); return undefined; }`,
  },
  'type-escape': {
    lint: 'type-escape',
    pillar: 'hygiene',
    summary: 'Explicit `any`, double assertions (`as unknown as T`), `@ts-ignore`/`@ts-nocheck`, or unjustified lint suppressions.',
    why: 'Type escapes disable compiler guarantees at the exact boundary where runtime bugs enter.',
    fix: 'Validate unknown inputs at the I/O boundary (e.g. with a schema or type guard) and use real types.',
    before: `const user = payload as unknown as User;`,
    after: `const user = parseUser(payload);`,
  },
  'pass-through': {
    lint: 'pass-through',
    pillar: 'hygiene',
    summary: 'An exported function or method that only forwards its parameters straight to another function.',
    why: 'Pass-through wrappers add indirection and cognitive load without hiding complexity (Ousterhout, Ch. 7).',
    fix: 'Call the underlying function directly or combine related steps into a genuinely deeper abstraction.',
    before: `export function saveUser(u: User) { return repo.saveUser(u); }`,
    after: `// Remove the pass-through or pull validation + persistence into a deeper operation`,
  },
  'complex-function': {
    lint: 'complex-function',
    pillar: 'hygiene',
    summary: 'A function exceeds line count (>120), control-flow nesting (>4), or positional parameters (>5).',
    why: 'Deeply nested god functions accumulate edge-case bugs and resist unit testing.',
    fix: 'Use guard clauses (early returns), group related options into a typed parameter object, and decompose cohesive sub-steps.',
    before: `function handle(a, b, c, d, e, f) { if (...) { for (...) { if (...) { try { ... } } } } }`,
    after: `function handle(input: HandleInput) { if (!valid(input)) return; ... }`,
  },
  'duplicate-logic': {
    lint: 'duplicate-logic',
    pillar: 'hygiene',
    summary: 'Two or more functions have identical normalised AST structure (copy-pasted logic).',
    why: 'Duplicated logic diverges silently on the next bug fix and inflates maintenance cost.',
    fix: 'Extract one shared helper owned by the appropriate module and parameterise the differing values.',
    before: `// fileA.ts and fileB.ts both implement the same 25-line retry loop with renamed variables`,
    after: `// shared retry helper called by both fileA.ts and fileB.ts`,
  },
};

export function formatExplanation(lint: LintKind): string {
  const g = GUIDES[lint];
  return [
    `trueline rule: ${g.lint} (${g.pillar})`,
    '',
    `Summary:`,
    `  ${g.summary}`,
    '',
    `Why it matters:`,
    `  ${g.why}`,
    '',
    `How to fix:`,
    `  ${g.fix}`,
    '',
    `Before:`,
    ...g.before.split('\n').map((l) => `  ${l}`),
    '',
    `After:`,
    ...g.after.split('\n').map((l) => `  ${l}`),
    '',
  ].join('\n');
}
