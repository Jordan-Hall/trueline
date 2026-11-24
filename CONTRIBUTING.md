# Contributing to trueline-lint

Thank you for your interest in contributing to **trueline-lint**!

## Design Principles

`trueline-lint` dogfoods itself on every commit. Keep changes aligned with its own rules:

1. **Deep modules, narrow interfaces**: Keep internal helpers private and expose small, cohesive entrypoints.
2. **Strict layer direction** (enforced by `trueline.json`):
   - `src/model/` is pure — no I/O, no TypeScript compiler dependency, no formatting.
   - `src/lint/`, `src/allow/`, and `src/format/` depend only on `src/model/`.
   - `src/workspace/` handles filesystem/git/Cargo discovery without depending on the analyzer or lints.
   - `src/analyzer/` converts TypeScript sources into a `Model` without knowing which lints consume it.
   - `src/cli/` orchestrates everything cleanly.
3. **Runtime-agnostic**: Never introduce Bun-only APIs inside `src/`. Everything must run cleanly on both Node.js 20+ (`node dist/cli/bin.js`) and Bun (`bun src/cli/bin.ts`).
4. **Deterministic & tested**: Every new lint or CLI feature needs unit tests on synthetic models and an end-to-end fixture test.

## Local Workflow

```bash
bun install
bun run verify   # typecheck + build + tests + Bun dogfood + Node dogfood
```
