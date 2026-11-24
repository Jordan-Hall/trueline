/**
 * Plain-text ratchet allowlist for existing architectural debt.
 *
 * Format: one `<lint> <key>` per line, sorted. Lines starting with `#` are
 * comments. Fixing an allowed entry never fails CI; new issues not listed fail.
 * Shrinking an allowed cycle or tangle (a subset of its members) stays allowed
 * so debt can be paid down incrementally.
 */

import { isLintKind, type Diagnostic, type LintKind } from '../model/types.ts';

interface AllowEntry {
  readonly lint: LintKind;
  readonly key: string;
}

export class AllowList {
  readonly #entries: readonly AllowEntry[];

  constructor(entries: readonly AllowEntry[]) {
    const deduped = new Map<string, AllowEntry>();
    for (const entry of entries) {
      deduped.set(`${entry.lint}\0${entry.key}`, entry);
    }
    this.#entries = [...deduped.values()].sort((a, b) =>
      a.lint !== b.lint
        ? a.lint.localeCompare(b.lint)
        : a.key.localeCompare(b.key),
    );
  }

  static fromDiagnostics(diagnostics: readonly Diagnostic[]): AllowList {
    return new AllowList(
      diagnostics.map((d) => ({ lint: d.lint, key: d.key })),
    );
  }

  static parse(text: string): AllowList {
    const entries: AllowEntry[] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i]!.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const space = trimmed.indexOf(' ');
      if (space === -1) {
        throw new Error(`Line ${i + 1}: invalid allowlist entry "${trimmed}"`);
      }
      const lintName = trimmed.slice(0, space);
      const key = trimmed.slice(space + 1).trim();
      if (!isLintKind(lintName) || key.length === 0) {
        throw new Error(`Line ${i + 1}: unknown lint or empty key "${trimmed}"`);
      }
      entries.push({ lint: lintName, key });
    }
    return new AllowList(entries);
  }

  size(): number {
    return this.#entries.length;
  }

  toText(toolName = 'trueline'): string {
    const lines = [
      `# Existing architectural debt suppressed by \`${toolName} --allow\`.`,
      '# Fixing an entry here never fails CI; new issues not listed here fail.',
    ];
    for (const entry of this.#entries) {
      lines.push(`${entry.lint} ${entry.key}`);
    }
    return `${lines.join('\n')}\n`;
  }

  isAllowed(diagnostic: Diagnostic): boolean {
    return this.#entries.some((entry) => covers(entry, diagnostic));
  }

  fixedCount(diagnostics: readonly Diagnostic[]): number {
    let fixed = 0;
    for (const entry of this.#entries) {
      if (!diagnostics.some((d) => covers(entry, d))) {
        fixed += 1;
      }
    }
    return fixed;
  }

  /**
   * Produces a tightened allowlist against `diagnostics`:
   * - Never adds unallowed diagnostics (returned separately in `unallowed`).
   * - Drops entries whose diagnostics are completely resolved (`removed`).
   * - Shrinks cycle/tangle entries whose remaining members are a strict subset (`shrunk`).
   */
  tighten(diagnostics: readonly Diagnostic[]): {
    readonly next: AllowList;
    readonly removed: number;
    readonly shrunk: number;
    readonly unallowed: readonly Diagnostic[];
  } {
    const unallowed = diagnostics.filter((d) => !this.isAllowed(d));
    const kept: AllowEntry[] = [];
    let removed = 0;
    let shrunk = 0;

    for (const entry of this.#entries) {
      const matching = diagnostics.filter((d) => covers(entry, d));
      if (matching.length === 0) {
        removed += 1;
        continue;
      }
      if (matching.some((d) => d.key === entry.key)) {
        kept.push(entry);
        continue;
      }
      // Every match is a strict subset of this cycle/tangle entry: tighten to the smaller key(s).
      shrunk += 1;
      for (const m of matching) {
        kept.push({ lint: m.lint, key: m.key });
      }
    }

    return {
      next: new AllowList(kept),
      removed,
      shrunk,
      unallowed,
    };
  }
}

function covers(entry: AllowEntry, diagnostic: Diagnostic): boolean {
  if (entry.lint !== diagnostic.lint) return false;
  if (entry.key === diagnostic.key) return true;
  if (
    entry.lint === 'module-cycle' ||
    entry.lint === 'package-cycle' ||
    entry.lint === 'tangle'
  ) {
    const allowedMembers = new Set(splitMembers(entry.key));
    const currentMembers = splitMembers(diagnostic.key);
    return (
      currentMembers.length > 0 &&
      currentMembers.every((member) => allowedMembers.has(member))
    );
  }
  return false;
}

/**
 * Splits a comma-separated member key while ignoring commas inside brackets
 * (`<...>`, `(...)`, `[...]`).
 */
function splitMembers(key: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < key.length; i += 1) {
    const ch = key[i];
    if (ch === '<' || ch === '(' || ch === '[') {
      depth += 1;
    } else if (ch === '>' || ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      members.push(key.slice(start, i));
      start = i + 1;
    }
  }
  members.push(key.slice(start));
  return members;
}
