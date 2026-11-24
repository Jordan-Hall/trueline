# Changelog

All notable changes to `trueline` will be documented in this file.

## [1.1.0](https://github.com/Jordan-Hall/trueline/compare/trueline-lint-v1.0.1...trueline-lint-v1.1.0) (2026-11-24)


### Features

* default to master branch, add release-please workflow, and add v1 launch film ([ba9cb6e](https://github.com/Jordan-Hall/trueline/commit/ba9cb6e3d63eba645aa88a0b4e777cc5299d385d))

## [1.0.0] - 2026-11-24

### Added
- **11 Architectural & Boundary Lints**: `module-cycle`, `package-cycle`, `tangle`, `field-leak`, `shallow-module`, `wide-directory`, `long-file`, `layer-violation`, `undeclared-dep`, `unused-export`, and `wildcard-barrel`.
- **7 Code-Hygiene & Anti-Slop Lints**: `verbose-comment`, `dead-code`, `silent-catch`, `type-escape`, `pass-through`, `complex-function`, and `duplicate-logic`.
- **Dual Runtime Support**: Runs natively on Node.js 20+ (`npx trueline`) and Bun (`bunx trueline`), with compiled ESM `dist/` output and TypeScript declarations.
- **Universal Workspace Discovery**: Supports npm/yarn/bun `package.json` `workspaces`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.json` `paths`/`baseUrl` aliases, and configurable custom-extension `preprocessors`.
- **Executive Reporting**: `text` (`rustc`-style with ASCII box-drawing pictures), `dashboard` (CLI KPI cards + proportional colour bars), `html` (standalone interactive dark/light report), `markdown` (`$GITHUB_STEP_SUMMARY` / PR comments), `json`, `sarif`, and `--badge` (shields.io JSON endpoint).
- **Ratchet & Trend Workflows**: Subset-tolerant `--allow` / `--update-allow` (root or `--per-package`), `--compare <baseline.json>` trend deltas, `--affected [baseRef]`, `--preset all|arch|slop|strict`, `--explain <lint>`, and optional `--rust` crate integration via `deslop-please`.
- **Tamper-Proof GitHub Governance**: `trueline github init`, `trueline github verify` (`pull_request_target` tamper protection for `.trueline.allow`, `trueline.json`, and protected workflows), and `trueline github merge` (automatic merge-time allowlist tightening via the GitHub Contents API).
- **Zero-Pollution Disk Cache**: Content-hashed per-package semantic cache stored under `~/.cache/trueline/`.
