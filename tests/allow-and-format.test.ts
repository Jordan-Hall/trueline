import { describe, expect, test } from 'bun:test';
import { AllowList } from '../src/allow/index.ts';
import { renderDiagnostics } from '../src/format/index.ts';
import type { Diagnostic, LintKind } from '../src/model/types.ts';

function diag(lint: LintKind, key: string): Diagnostic {
  return {
    lint,
    key,
    message: `${lint} message`,
    location: { file: 'src/a.ts', line: 5, column: 1 },
    notes: ['note one'],
    picture: {
      kind: 'circle',
      steps: [
        {
          member: 'a',
          site: { file: 'src/a.ts', line: 5, column: 1 },
          uses: 'foo uses bar',
        },
        {
          member: 'b',
          site: { file: 'src/b.ts', line: 9, column: 1 },
          uses: 'bar uses foo',
        },
      ],
      rest: undefined,
    },
  };
}

describe('AllowList', () => {
  test('shrinking an allowed cycle or tangle stays allowed', () => {
    const allow = AllowList.parse(
      '# comment\ntangle a:X,a:Y,b:Z\nmodule-cycle p/a,p/b,p/c\npackage-cycle @a/x,@a/y,@a/z\n',
    );

    expect(allow.isAllowed(diag('tangle', 'a:X,b:Z'))).toBe(true);
    expect(allow.isAllowed(diag('tangle', 'a:W,a:X,a:Y,b:Z'))).toBe(false);
    expect(allow.isAllowed(diag('module-cycle', 'p/a,p/c'))).toBe(true);
    expect(allow.isAllowed(diag('package-cycle', '@a/x,@a/z'))).toBe(true);
    expect(allow.isAllowed(diag('tangle', 'p/a,p/c'))).toBe(false);

    expect(allow.fixedCount([diag('tangle', 'a:X,a:Y')])).toBe(2);
    expect(allow.fixedCount([])).toBe(3);
  });

  test('round-trips via toText and rejects unknown lints', () => {
    const original = AllowList.fromDiagnostics([
      diag('field-leak', 'p/q:RunQueue.items'),
      diag('long-file', 'src/big.ts'),
    ]);
    const parsed = AllowList.parse(original.toText());
    expect(parsed.size()).toBe(2);
    expect(parsed.isAllowed(diag('field-leak', 'p/q:RunQueue.items'))).toBe(true);
    expect(() => AllowList.parse('made-up-lint foo\n')).toThrow();
  });
});

describe('Formatters', () => {
  test('renders text with ASCII circle, json, and sarif', () => {
    const items = [diag('module-cycle', 'p/a,p/b')];

    const text = renderDiagnostics(items, 'text', {
      color: false,
      fixedAllowed: 1,
      allowPath: '.trueline.allow',
    });
    expect(text).toContain('error[module-cycle]:');
    expect(text).toContain('┌─▶ a');
    expect(text).toContain('1 allowed entry in .trueline.allow are now fixed');

    const json = JSON.parse(renderDiagnostics(items, 'json'));
    expect(json.errorCount).toBe(1);
    expect(json.diagnostics[0].lint).toBe('module-cycle');

    const sarif = JSON.parse(renderDiagnostics(items, 'sarif'));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results[0].ruleId).toBe('module-cycle');
  });
});
