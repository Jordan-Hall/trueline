# trueline

**Deterministic architectural and code-hygiene linter for TypeScript and monorepos.**

Built around John Ousterhout's *A Philosophy of Software Design* and Clean Architecture: **deep modules, narrow interfaces, clear boundaries, zero slop**. Runs natively on **Node.js 20+** and **Bun**, across single packages, npm/yarn/bun workspaces, `pnpm-workspace.yaml`, and Turborepo monorepos (with optional Rust workspace support via [`deslop-please`](https://github.com/deterministic-machines/deslop-please)).

---

## 18 Deterministic Lints

### Architecture & Boundaries (`--preset arch`)
| Lint | What it catches |
|---|---|
| `module-cycle` | Sibling modules or directories importing each other in a circle, highlighting the cheapest edge to cut |
| `package-cycle` | Workspace packages depending on each other in a circular graph |
| `tangle` | Symbol-level strongly connected components spanning `> 1` module or `> 7` symbols inside one module |
| `field-leak` | External mutations or mutating calls on guarded class fields — piercing getters, setters, and forwarders |
| `shallow-module` | Packages or multi-file directories showing `> 7` working functions while hiding no more than they show |
| `wide-directory` | Directories holding `> 15` source files and subdirectories |
| `long-file` | Source files exceeding `1500` lines |
| `layer-violation` | Clean Architecture rings (`domain` → `application` → `infrastructure`/`routes`/`ui`), `packages → apps`, custom family rules, and vertical `featureSlices` |
| `undeclared-dep` | Importing a workspace package not declared in `package.json` |
| `unused-export` | Internal module exports never imported anywhere else in the workspace |
| `wildcard-barrel` | `export * from '...'` re-exports that obscure boundaries and hurt tree-shaking |

### Code Hygiene & Anti-Slop (`--preset slop`)
| Lint | What it catches |
|---|---|
| `verbose-comment` | ASCII banner dividers, line-by-line narration comments, git-history prose, and `> 40%` inline comment bloat |
| `dead-code` | Commented-out code blocks (3+ lines), unimplemented stubs, `debugger`, and leftover `console.log`/`console.debug` |
| `silent-catch` | Empty `catch {}` blocks or silent fallback returns inside `catch` with no logging, rethrow, or rationale |
| `type-escape` | Explicit `any`, double assertions (`as unknown as T`), `@ts-ignore`/`@ts-nocheck`, and unjustified disable comments |
| `pass-through` | Exported trivial wrapper functions that only forward arguments to another function without adding depth |
| `complex-function` | Functions exceeding line count (`120`), control-flow nesting depth (`4`), or positional parameters (`5`) |
| `duplicate-logic` | Structurally identical copy-pasted functions across files via alpha-normalised AST fingerprinting |

Run `trueline --explain <lint>` for the principle and a Before/After TypeScript example for any rule.

---

## Quick Start

```bash
# Run without installing (Node 20+ or Bun)
npx trueline --format dashboard
bunx trueline --format dashboard

# Or install globally / link locally
npm install -g trueline
```

### Everyday Commands

```bash
# Executive CLI dashboard (4 KPI cards, lint bars, hotspots, 1-item quick-win cycles)
trueline --format dashboard

# CLI dashboard + standalone interactive HTML report + Rust crates
trueline --format dashboard --html ./trueline-report.html --rust

# Architecture rules only (great alongside ESLint/Oxlint)
trueline --preset arch

# Strict thresholds (maxFileLines: 800, maxFunctionLines: 80, maxNestingDepth: 3)
trueline --preset strict

# Scope to one package locally (fast for per-package Turborepo tasks)
trueline @my-org/payments --local

# Check only packages affected since origin/main (+ transitive dependents)
trueline --affected origin/main

# Compare against a previous JSON baseline to see trend deltas
trueline --format json -o baseline.json
trueline --format dashboard --compare baseline.json

# Explain any rule
trueline --explain field-leak
```

---

## Ratchet Existing Debt (`--allow` / `--update-allow`)

Adopt `trueline` in CI immediately with zero noise for existing debt:

```bash
# Snapshot current architectural & hygiene debt
trueline --update-allow .trueline.allow

# Enforce in CI: existing debt stays quiet, any new violation fails
trueline --allow .trueline.allow

# Or keep per-package `.trueline.allow` files for Turborepo
trueline --per-package --update-allow .trueline.allow
trueline --per-package
```

- **Shrinking an allowed `module-cycle`, `package-cycle`, or `tangle` stays allowed** — incremental progress never breaks CI.
- Cache is stored per-repository under `~/.cache/trueline/`, so scanning any project never leaves untracked files behind.

---

## Configuration (`trueline.json`)

Run `trueline --init` to create a starter `trueline.json` and print a ready-to-paste `AGENTS.md` snippet.

```json
{
  "$schema": "./node_modules/trueline/schema/trueline.schema.json",
  "heldInMind": 7,
  "maxDirectoryMembers": 15,
  "maxFileLines": 1500,
  "maxFunctionLines": 120,
  "maxNestingDepth": 4,
  "maxParameters": 5,
  "layers": {
    "preset": "clean-architecture",
    "noPackageToApp": true,
    "featureSlices": ["apps/*/src/features/*"],
    "rules": [
      {
        "name": "core-no-ui",
        "from": "packages/core/**",
        "deny": ["packages/ui/**"],
        "reason": "Core domain packages must not depend on UI packages."
      }
    ]
  }
}
```

---

## CI, Governance & Turborepo Recipes

### Tamper-Proof GitHub Governance (`trueline github init`)

Prevent pull requests from silently expanding `.trueline.allow` or weakening `trueline.json`, and tighten debt automatically on merge:

```bash
trueline github init --branch main
```

This scaffolds two workflows:
1. **`.github/workflows/trueline-verify.yml`** (`on: pull_request_target`): installs the pinned `trueline` binary outside the workspace without executing any PR code and runs `trueline github verify`. It fails any PR that modifies `.trueline.allow`, alters protected workflow/CODEOWNERS files, changes the `github` block, disables lints, raises thresholds, adds `ignore` patterns, or removes/alters layer rules.
2. **`.github/workflows/trueline-merge.yml`** (`on: push` to `main`, ignoring `**/.trueline.allow`): runs `trueline github merge`. When debt is resolved or a cycle/tangle shrinks, it tightens `.trueline.allow` through the GitHub Contents API (supporting an optional GitHub App via `vars.TRUELINE_APP_ID` + `secrets.TRUELINE_APP_KEY` for ruleset-protected branches) and comments on the merged PR.

Add a `github` block to `trueline.json` to lock `--update-allow` locally as well:

```json
{
  "github": {
    "ratchet": "merge",
    "branch": "main",
    "protect": [
      ".github/workflows/trueline-verify.yml",
      ".github/workflows/trueline-merge.yml",
      ".github/CODEOWNERS"
    ]
  }
}
```

### GitHub Actions Step Summary + Badge

```yaml
- name: Architectural check
  run: npx trueline --allow .trueline.allow --format markdown --badge badge.json >> "$GITHUB_STEP_SUMMARY"
```

### Turborepo (`turbo.json`)

```json
{
  "tasks": {
    "check-arch": {
      "inputs": ["$TURBO_DEFAULT$", ".trueline.allow", "$TURBO_ROOT$/trueline.json"],
      "outputs": [],
      "cache": true
    }
  }
}
```

---

## Output Formats

| Format | Flag | Purpose |
|---|---|---|
| Text | `--format text` (default) | `rustc`-style clickable `file:line:col` diagnostics with ASCII diagrams |
| Dashboard | `--format dashboard` | Executive CLI view: 4 KPI cards, lint bars, top hotspots, quick-win cycles, Rust strip |
| HTML | `--format html` / `--html <file>` | Self-contained dark/light interactive dashboard with clickable filters & findings explorer |
| Markdown | `--format markdown` | GitHub-Flavoured Markdown tables for PR comments & `$GITHUB_STEP_SUMMARY` |
| JSON | `--format json` | Machine-readable output (also serves as `--compare` baseline input) |
| SARIF | `--format sarif` | SARIF 2.1.0 for GitHub Code Scanning & IDE problem matchers |

## License

MIT
