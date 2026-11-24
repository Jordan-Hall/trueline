/**
 * Deterministic code-hygiene and anti-slop scanner for TypeScript/JavaScript
 * source files:
 *
 * - `verbose-comment`: divider banners, line-by-line AI narration comments,
 *   change-history prose, and excessive comment-to-code bloat.
 * - `dead-code`: commented-out code blocks, unimplemented stubs, `debugger`,
 *   and leftover `console.log`/`console.debug` in library modules.
 * - `silent-catch`: empty catch blocks or silent fallback returns inside catch
 *   with no logging, rethrow, or rationale.
 * - `type-escape`: explicit `any`, double assertions (`as unknown as T`),
 *   `@ts-ignore` / `@ts-nocheck`, and unjustified lint disable comments.
 */

import ts from 'typescript';
import type { TextSlopKind } from '../model/types.ts';

export interface SerializedSlopFinding {
  readonly lint: TextSlopKind;
  readonly fileIndex: number;
  readonly line: number;
  readonly column: number;
  readonly rule: string;
  readonly detail: string;
  readonly isTest: boolean;
}

const BANNER_COMMENT = /^\/\/\s*([=\-*#~_]{8,})\s*(?:[\w\s/-]{0,40}\1?)?\s*$/;

const NARRATION_COMMENT =
  /^\/\/\s*(?:step\s+\d+\s*[:.-]|helper\s+(?:function|method)\s+(?:to|for|that)\b|this\s+(?:function|method|class|block|loop|code)\s+(?:is|will|does|handles|returns|checks|creates)\b|(?:now\s+)?(?:we\s+)?(?:increment|decrement|initialize|initialise|return\s+the\s+result|check\s+if\s+the|loop\s+through|iterate\s+over|define\s+the|create\s+a\s+new|set\s+the\s+value|import\s+the)\b)/i;

const HISTORY_COMMENT =
  /^\/\/\s*(?:previously\b|changed\s+from\b|updated\s+(?:from|to\s+fix)\b|added\s+(?:by|for\s+ticket|to\s+support)\b|removed\s+old\b|refactored\s+from\b|fixed\s+bug\s+where\b)/i;

const CODE_IN_COMMENT =
  /^\/\/\s*(?:(?:export\s+)?(?:const|let|var|function|class|interface|type|return|import|if|else|for|while|switch|try|catch|await)\b|[a-zA-Z_$][\w$.]*\s*(?:\([^)]*\)\s*;?|=\s*[^=]|=>)|[{}[\]();]+\s*$)/;

const DISABLE_DIRECTIVE =
  /^\/\/\s*(?:@ts-ignore\b|@ts-nocheck\b|eslint-disable(?:-next-line|-line)?\b|oxlint-disable(?:-next-line|-line)?\b|biome-ignore\b)/;

const STUB_ERROR_RE = /\b(?:not\s+implemented|todo|fixme|unimplemented|stub)\b/i;

export function scanFileSlop(
  sf: ts.SourceFile,
  fileIndex: number,
  relPath: string,
  isTest: boolean,
): SerializedSlopFinding[] {
  if (isTest) return [];
  const findings: SerializedSlopFinding[] = [];
  const text = sf.text;
  const lines = text.split(/\r?\n/);

  scanLineComments(lines, fileIndex, findings);
  scanAstSlop(sf, fileIndex, relPath, findings);

  return findings;
}

function scanLineComments(
  lines: readonly string[],
  fileIndex: number,
  findings: SerializedSlopFinding[],
): void {
  let codeLines = 0;
  let inlineCommentLines = 0;
  let inBlockComment = false;
  let commentedCodeRunStart = -1;
  let commentedCodeRunLen = 0;

  const flushCodeRun = (): void => {
    if (commentedCodeRunLen >= 3 && commentedCodeRunStart >= 0) {
      findings.push({
        lint: 'dead-code',
        fileIndex,
        line: commentedCodeRunStart + 1,
        column: 1,
        rule: 'commented-out-code',
        detail: `${commentedCodeRunLen} consecutive lines of commented-out code`,
        isTest: false,
      });
    }
    commentedCodeRunStart = -1;
    commentedCodeRunLen = 0;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      flushCodeRun();
      continue;
    }

    if (trimmed.startsWith('/*')) {
      flushCodeRun();
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }

    if (trimmed.length === 0) {
      flushCodeRun();
      continue;
    }

    if (trimmed.startsWith('//')) {
      const col = raw.indexOf('//') + 1;

      if (DISABLE_DIRECTIVE.test(trimmed)) {
        flushCodeRun();
        const directive = trimmed.slice(2).trim();
        const isBlanketTs =
          directive.startsWith('@ts-ignore') || directive.startsWith('@ts-nocheck');
        const hasReason = /--|:|\s+\S+\s+\S+/.test(
          directive.replace(/^[\w@/-]+/, ''),
        );
        if (isBlanketTs || !hasReason) {
          findings.push({
            lint: 'type-escape',
            fileIndex,
            line: i + 1,
            column: col,
            rule: 'suppression-directive',
            detail: `Unjustified suppression comment \`${trimmed.slice(0, 60)}\``,
            isTest: false,
          });
        }
        continue;
      }

      inlineCommentLines += 1;

      if (BANNER_COMMENT.test(trimmed)) {
        flushCodeRun();
        findings.push({
          lint: 'verbose-comment',
          fileIndex,
          line: i + 1,
          column: col,
          rule: 'banner-divider',
          detail: 'ASCII divider banner comment adds visual noise',
          isTest: false,
        });
        continue;
      }

      if (NARRATION_COMMENT.test(trimmed)) {
        flushCodeRun();
        findings.push({
          lint: 'verbose-comment',
          fileIndex,
          line: i + 1,
          column: col,
          rule: 'narration-comment',
          detail: `Comment narrates the code instead of explaining why: \`${trimmed.slice(0, 64)}\``,
          isTest: false,
        });
        continue;
      }

      if (HISTORY_COMMENT.test(trimmed)) {
        flushCodeRun();
        findings.push({
          lint: 'verbose-comment',
          fileIndex,
          line: i + 1,
          column: col,
          rule: 'history-comment',
          detail: `Change-history comment belongs in git history: \`${trimmed.slice(0, 64)}\``,
          isTest: false,
        });
        continue;
      }

      if (CODE_IN_COMMENT.test(trimmed)) {
        if (commentedCodeRunStart === -1) commentedCodeRunStart = i;
        commentedCodeRunLen += 1;
      } else {
        flushCodeRun();
      }
      continue;
    }

    flushCodeRun();
    codeLines += 1;
  }

  flushCodeRun();

  // Flag files drowned in inline prose comments (>40% of non-blank lines on >=40 code lines).
  if (codeLines >= 40) {
    const ratio = inlineCommentLines / (codeLines + inlineCommentLines);
    if (ratio > 0.4) {
      findings.push({
        lint: 'verbose-comment',
        fileIndex,
        line: 1,
        column: 1,
        rule: 'comment-ratio',
        detail: `${Math.round(ratio * 100)}% of non-blank lines are inline comments (${inlineCommentLines} comment vs ${codeLines} code lines)`,
        isTest: false,
      });
    }
  }
}

function scanAstSlop(
  sf: ts.SourceFile,
  fileIndex: number,
  relPath: string,
  findings: SerializedSlopFinding[],
): void {
  const isCliOrScript =
    /(?:^|\/)(?:cli|bin|scripts|tools)\//.test(relPath) ||
    /\/(?:cli|bin)\.[cm]?[jt]sx?$/.test(relPath);

  const posOf = (node: ts.Node) => {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: pos.line + 1, column: pos.character + 1 };
  };

  const visit = (node: ts.Node): void => {
    // 1. Explicit `any` keyword (`: any`, `as any`, `<any>`)
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const { line, column } = posOf(node);
      findings.push({
        lint: 'type-escape',
        fileIndex,
        line,
        column,
        rule: 'explicit-any',
        detail: 'Explicit `any` bypasses type checking',
        isTest: false,
      });
    }

    // 2. Double type assertion (`x as unknown as T`)
    if (
      ts.isAsExpression(node) &&
      ts.isAsExpression(unwrapParens(node.expression))
    ) {
      const inner = unwrapParens(node.expression) as ts.AsExpression;
      if (
        inner.type.kind === ts.SyntaxKind.UnknownKeyword ||
        inner.type.kind === ts.SyntaxKind.AnyKeyword
      ) {
        const { line, column } = posOf(node);
        findings.push({
          lint: 'type-escape',
          fileIndex,
          line,
          column,
          rule: 'double-assertion',
          detail: 'Double type assertion (`as unknown as ...`) forces an unchecked cast',
          isTest: false,
        });
      }
    }

    // 3. `debugger` statement
    if (ts.isDebuggerStatement(node)) {
      const { line, column } = posOf(node);
      findings.push({
        lint: 'dead-code',
        fileIndex,
        line,
        column,
        rule: 'debugger-statement',
        detail: 'Leftover `debugger` statement',
        isTest: false,
      });
    }

    // 4. Leftover `console.log` / `console.debug` in non-CLI library modules
    if (
      !isCliOrScript &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'console' &&
      (node.expression.name.text === 'log' || node.expression.name.text === 'debug')
    ) {
      const { line, column } = posOf(node);
      findings.push({
        lint: 'dead-code',
        fileIndex,
        line,
        column,
        rule: 'debug-console',
        detail: `Leftover \`console.${node.expression.name.text}()\` in library/service code`,
        isTest: false,
      });
    }

    // 5. Unimplemented stubs (`throw new Error('Not implemented')` or TODO-only body)
    if (
      ts.isThrowStatement(node) &&
      node.expression !== undefined &&
      ts.isNewExpression(node.expression) &&
      node.expression.arguments !== undefined &&
      node.expression.arguments.length >= 1 &&
      ts.isStringLiteral(node.expression.arguments[0]!) &&
      STUB_ERROR_RE.test(node.expression.arguments[0]!.text)
    ) {
      const { line, column } = posOf(node);
      findings.push({
        lint: 'dead-code',
        fileIndex,
        line,
        column,
        rule: 'unimplemented-stub',
        detail: `Unimplemented stub throws \`${node.expression.arguments[0]!.text}\``,
        isTest: false,
      });
    }

    // 6. Silent catch blocks (empty catch or silent fallback return with no comment/log)
    if (ts.isCatchClause(node)) {
      const block = node.block;
      const blockSlice = sf.text.slice(block.getStart(sf), block.getEnd());
      const hasRationaleComment = /\/\/|\/\*/.test(blockSlice);

      if (block.statements.length === 0 && !hasRationaleComment) {
        const { line, column } = posOf(node);
        findings.push({
          lint: 'silent-catch',
          fileIndex,
          line,
          column,
          rule: 'empty-catch',
          detail: 'Empty `catch` swallows errors silently with no rationale',
          isTest: false,
        });
      } else if (
        block.statements.length === 1 &&
        !hasRationaleComment &&
        isSilentFallbackStatement(block.statements[0]!)
      ) {
        const { line, column } = posOf(node);
        findings.push({
          lint: 'silent-catch',
          fileIndex,
          line,
          column,
          rule: 'silent-fallback-catch',
          detail: '`catch` swallows error and returns a silent fallback value',
          isTest: false,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
}

function isSilentFallbackStatement(stmt: ts.Statement): boolean {
  if (!ts.isReturnStatement(stmt)) return false;
  const expr = stmt.expression;
  if (expr === undefined) return true;
  if (
    expr.kind === ts.SyntaxKind.NullKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(expr) && expr.text === 'undefined')
  ) {
    return true;
  }
  if (ts.isStringLiteral(expr) && expr.text === '') return true;
  if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 0) return true;
  if (ts.isObjectLiteralExpression(expr) && expr.properties.length === 0) return true;
  return false;
}

function unwrapParens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}
