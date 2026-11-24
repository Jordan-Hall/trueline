/**
 * Function complexity & normalised AST structural clone fingerprinting.
 *
 * Measures each function/method's line count, max control-flow nesting depth,
 * parameter count, and a variable-name-normalised token fingerprint for
 * deterministic copy-paste clone detection.
 */

import { createHash } from 'node:crypto';
import ts from 'typescript';

export interface SerializedFunctionMetric {
  readonly fileIndex: number;
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

const MIN_TOKENS_TO_HASH = 30;

export function scanFunctionMetrics(
  sf: ts.SourceFile,
  fileIndex: number,
  isTest: boolean,
): SerializedFunctionMetric[] {
  if (isTest) return [];
  const metrics: SerializedFunctionMetric[] = [];

  const visit = (node: ts.Node, className: string | undefined): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const nextClass = node.name?.text ?? className;
      ts.forEachChild(node, (child) => visit(child, nextClass));
      return;
    }

    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)) &&
      node.body !== undefined
    ) {
      const name = resolveFunctionName(node, className);
      if (name !== undefined) {
        const startPos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const endPos = sf.getLineAndCharacterOfPosition(node.getEnd());
        const lineCount = endPos.line - startPos.line + 1;
        const paramCount = node.parameters.filter(
          (p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'),
        ).length;
        const maxNesting = computeMaxNesting(node.body);
        const { tokenCount, fingerprint } = computeFingerprint(sf, node.body);

        metrics.push({
          fileIndex,
          line: startPos.line + 1,
          column: startPos.character + 1,
          name,
          lines: lineCount,
          maxNesting,
          paramCount,
          tokenCount,
          fingerprint,
          isTest,
        });
      }
    }

    ts.forEachChild(node, (child) => visit(child, className));
  };

  visit(sf, undefined);
  return metrics;
}

function resolveFunctionName(
  node:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ArrowFunction
    | ts.FunctionExpression,
  className: string | undefined,
): string | undefined {
  if (ts.isFunctionDeclaration(node)) {
    return node.name?.text;
  }
  if (ts.isMethodDeclaration(node)) {
    const raw =
      ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)
        ? node.name.text
        : undefined;
    if (raw === undefined) return undefined;
    return className !== undefined ? `${className}.${raw}` : raw;
  }
  const parent = node.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (
    parent !== undefined &&
    ts.isPropertyDeclaration(parent) &&
    ts.isIdentifier(parent.name)
  ) {
    return className !== undefined
      ? `${className}.${parent.name.text}`
      : parent.name.text;
  }
  return undefined;
}

function computeMaxNesting(body: ts.ConciseBody): number {
  let deepest = 0;

  const walk = (node: ts.Node, depth: number): void => {
    // Do not merge nested function bodies into the outer function's nesting depth.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return;
    }

    let nextDepth = depth;
    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isTryStatement(node)
    ) {
      // `else if` stays at the same logical nesting level as its `if`.
      const isElseIf =
        ts.isIfStatement(node) &&
        node.parent !== undefined &&
        ts.isIfStatement(node.parent) &&
        node.parent.elseStatement === node;
      if (!isElseIf) {
        nextDepth = depth + 1;
        if (nextDepth > deepest) deepest = nextDepth;
      }
    }

    ts.forEachChild(node, (child) => walk(child, nextDepth));
  };

  ts.forEachChild(body, (child) => walk(child, 0));
  return deepest;
}

/**
 * Tokenises a function body with alpha-normalised identifiers and literal
 * placeholders so structurally identical copy-pasted functions hash identically.
 */
function computeFingerprint(
  sf: ts.SourceFile,
  body: ts.ConciseBody,
): { readonly tokenCount: number; readonly fingerprint: string | undefined } {
  const slice = sf.text.slice(body.getStart(sf), body.getEnd());
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES2024,
    true,
    ts.LanguageVariant.Standard,
    slice,
  );

  const tokens: string[] = [];
  const identMap = new Map<string, string>();

  while (true) {
    const kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;

    if (kind === ts.SyntaxKind.Identifier) {
      const text = scanner.getTokenText();
      let alias = identMap.get(text);
      if (alias === undefined) {
        alias = `$${identMap.size}`;
        identMap.set(text, alias);
      }
      tokens.push(alias);
    } else if (
      kind === ts.SyntaxKind.StringLiteral ||
      kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      tokens.push('$STR');
    } else if (
      kind === ts.SyntaxKind.NumericLiteral ||
      kind === ts.SyntaxKind.BigIntLiteral
    ) {
      tokens.push('$NUM');
    } else {
      tokens.push(`k${kind}`);
    }
  }

  if (tokens.length < MIN_TOKENS_TO_HASH) {
    return { tokenCount: tokens.length, fingerprint: undefined };
  }

  const fingerprint = createHash('sha256')
    .update(tokens.join(' '))
    .digest('hex')
    .slice(0, 16);
  return { tokenCount: tokens.length, fingerprint };
}
