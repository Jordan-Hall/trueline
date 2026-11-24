/**
 * Per-package semantic extractor powered by TypeScript's AST and TypeChecker.
 *
 * Emits a serialisable `PackageSummary` (files, items, intra-package
 * references, wrapper forwarders/accessors, imports, and exported symbol map)
 * so each workspace package can be cached independently and merged into the
 * full workspace `Model`.
 */

import { relative, resolve } from 'node:path';
import ts from 'typescript';
import type { ItemKind, TruelineConfig, Wrapper } from '../model/types.ts';
import { toPosix, type WorkspacePackage } from '../workspace/discover.ts';
import { scanFunctionMetrics, type SerializedFunctionMetric } from './metrics.ts';
import {
  createPackageProgram,
  resolveModuleSpecifier,
  type PathAliasTable,
} from './program.ts';
import { scanFileSlop, type SerializedSlopFinding } from './slop.ts';

export interface SerializedFile {
  readonly path: string;
  readonly moduleSegments: readonly string[];
  readonly isTest: boolean;
  readonly isEntrypoint: boolean;
  readonly lines: number;
}

export interface SerializedItem {
  readonly localId: number;
  readonly name: string;
  readonly fileIndex: number;
  readonly line: number;
  readonly kind: ItemKind;
  readonly parentLocalId: number | undefined;
  readonly exported: boolean;
  readonly takesSelf: boolean;
  readonly isLifecycle: boolean;
  readonly holdsNothing: boolean;
}

export interface SerializedReference {
  readonly fileIndex: number;
  readonly line: number;
  readonly column: number;
  readonly holderLocalId: number | undefined;
  readonly targetLocalId: number;
  readonly copies: boolean;
  readonly typeOnly: boolean;
  readonly isTest: boolean;
}

export interface SerializedImport {
  readonly fileIndex: number;
  readonly line: number;
  readonly column: number;
  readonly specifier: string;
  readonly targetRelPath: string | undefined;
  readonly symbols: readonly string[];
  readonly typeOnly: boolean;
  readonly isWildcardReExport: boolean;
  readonly isTest: boolean;
}

export interface SerializedWrapper {
  readonly localId: number;
  readonly wrapper: Wrapper;
}

export interface PackageSummary {
  readonly packageName: string;
  readonly relDir: string;
  readonly files: readonly SerializedFile[];
  readonly items: readonly SerializedItem[];
  readonly references: readonly SerializedReference[];
  readonly imports: readonly SerializedImport[];
  readonly wrappers: readonly SerializedWrapper[];
  readonly slopFindings: readonly SerializedSlopFinding[];
  readonly functions: readonly SerializedFunctionMetric[];
  /** Publicly exported symbol names -> localItemId (piercing barrel re-exports). */
  readonly exports: Readonly<Record<string, number>>;
}

const LIFECYCLE_METHODS = new Set([
  'constructor',
  'toString',
  'valueOf',
  'toJSON',
  'toLocaleString',
  'inspect',
]);

const MUTATING_COLLECTION_METHODS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
  'set',
  'add',
  'delete',
  'clear',
]);

const READONLY_COLLECTION_METHODS = new Set([
  'get',
  'has',
  'includes',
  'indexOf',
  'lastIndexOf',
  'find',
  'findIndex',
  'some',
  'every',
  'filter',
  'map',
  'flatMap',
  'reduce',
  'reduceRight',
  'slice',
  'concat',
  'join',
  'entries',
  'keys',
  'values',
  'forEach',
  'at',
  'toSorted',
  'toReversed',
  'toSpliced',
]);

export function extractPackageSummary(
  rootDir: string,
  pkg: WorkspacePackage,
  config: TruelineConfig,
): PackageSummary {
  if (pkg.files.length === 0) {
    return {
      packageName: pkg.name,
      relDir: pkg.relDir,
      files: [],
      items: [],
      references: [],
      imports: [],
      wrappers: [],
      slopFindings: [],
      functions: [],
      exports: {},
    };
  }

  const { checker, sourceFiles, rawLineCounts, pathAliases } =
    createPackageProgram(rootDir, pkg, config);

  const files: SerializedFile[] = [];
  const fileIndexByAbs = new Map<string, number>();

  for (const sf of sourceFiles) {
    const abs = toPosix(resolve(sf.fileName));
    const rel = toPosix(relative(rootDir, abs));
    const fileIndex = files.length;
    fileIndexByAbs.set(abs, fileIndex);
    files.push({
      path: rel,
      moduleSegments: moduleSegmentsFor(rel, pkg.relDir),
      isTest: isTestFilePath(rel),
      isEntrypoint: pkg.entrypoints.has(rel),
      lines: rawLineCounts.get(abs) ?? sf.getLineAndCharacterOfPosition(sf.end).line + 1,
    });
  }

  // Pass 1: Collect declarations (items) and map TS Symbols -> localItemId.
  const { items, itemBySymbol, itemByDecl, funcDeclItems } =
    collectPackageDeclarations(sourceFiles, checker);

  // Helper: resolve any TS symbol (piercing import/export aliases) to localItemId.
  const resolveSymbolToItem = (sym: ts.Symbol | undefined): number | undefined => {
    if (sym === undefined) return undefined;
    const direct = itemBySymbol.get(sym);
    if (direct !== undefined) return direct;
    let current = sym;
    const seen = new Set<ts.Symbol>();
    while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
      seen.add(current);
      try {
        current = checker.getAliasedSymbol(current);
      } catch {
        // Broken or external alias terminates chain cleanly.
        break;
      }
      const mapped = itemBySymbol.get(current);
      if (mapped !== undefined) return mapped;
    }
    if (current.declarations !== undefined) {
      for (const decl of current.declarations) {
        const byDecl = itemByDecl.get(decl);
        if (byDecl !== undefined) return byDecl;
      }
    }
    return undefined;
  };

  // Pass 2: Detect wrappers (forwarders and accessors) so the Graph can pierce them.
  const wrappers: SerializedWrapper[] = [];
  for (const fn of funcDeclItems) {
    const detected = detectWrapper(
      fn.node,
      fn.parentClassId,
      checker,
      resolveSymbolToItem,
      items,
    );
    if (detected !== undefined) {
      wrappers.push({ localId: fn.itemId, wrapper: detected });
    }
  }

  // Pass 3: Extract imports, semantic references, slop findings, and function metrics.
  const { imports, references, slopFindings, functions } =
    collectImportsRefsAndMetrics({
      rootDir,
      sourceFiles,
      files,
      items,
      itemByDecl,
      wrappers,
      checker,
      resolveSymbolToItem,
      pathAliases,
      extensions: config.extensions,
    });

  // Pass 4: Collect exported symbol map for cross-package resolution (piercing barrels).
  const exportsMap: Record<string, number> = {};
  for (const sf of sourceFiles) {
    const modSym = checker.getSymbolAtLocation(sf);
    if (modSym === undefined) continue;
    for (const expSym of checker.getExportsOfModule(modSym)) {
      const targetId = resolveSymbolToItem(expSym);
      if (targetId !== undefined) {
        exportsMap[expSym.name] = targetId;
      }
    }
  }

  return {
    packageName: pkg.name,
    relDir: pkg.relDir,
    files,
    items,
    references,
    imports,
    wrappers,
    slopFindings,
    functions,
    exports: exportsMap,
  };
}

interface FuncDeclEntry {
  readonly node: ts.FunctionLikeDeclaration;
  readonly itemId: number;
  readonly parentClassId: number | undefined;
  readonly fileIndex: number;
}

function collectPackageDeclarations(
  sourceFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
): {
  readonly items: SerializedItem[];
  readonly itemBySymbol: Map<ts.Symbol, number>;
  readonly itemByDecl: Map<ts.Node, number>;
  readonly funcDeclItems: FuncDeclEntry[];
} {
  const items: SerializedItem[] = [];
  const itemBySymbol = new Map<ts.Symbol, number>();
  const itemByDecl = new Map<ts.Node, number>();
  const funcDeclItems: FuncDeclEntry[] = [];

  const addItem = (
    item: Omit<SerializedItem, 'localId'>,
    decl: ts.Node,
    symNode?: ts.Node,
  ): number => {
    const localId = items.length;
    items.push({ localId, ...item });
    itemByDecl.set(decl, localId);
    const sym =
      symNode !== undefined ? checker.getSymbolAtLocation(symNode) : undefined;
    if (sym !== undefined) itemBySymbol.set(sym, localId);
    return localId;
  };

  for (let fileIndex = 0; fileIndex < sourceFiles.length; fileIndex += 1) {
    const sf = sourceFiles[fileIndex]!;
    for (const stmt of sf.statements) {
      collectTopLevelStatement(sf, stmt, fileIndex, checker, addItem, itemByDecl, funcDeclItems);
    }
  }

  return { items, itemBySymbol, itemByDecl, funcDeclItems };
}

function collectTopLevelStatement(
  sf: ts.SourceFile,
  stmt: ts.Statement,
  fileIndex: number,
  checker: ts.TypeChecker,
  addItem: (item: Omit<SerializedItem, 'localId'>, decl: ts.Node, symNode?: ts.Node) => number,
  itemByDecl: Map<ts.Node, number>,
  funcDeclItems: FuncDeclEntry[],
): void {
  const exported = hasExportModifier(stmt);
  const line = lineOf(sf, stmt);

  if (ts.isClassDeclaration(stmt) && stmt.name !== undefined) {
    const classId = addItem(
      {
        name: stmt.name.text,
        fileIndex,
        line,
        kind: 'type',
        parentLocalId: undefined,
        exported,
        takesSelf: false,
        isLifecycle: false,
        holdsNothing: false,
      },
      stmt,
      stmt.name,
    );
    collectClassMembers(sf, stmt, stmt.name.text, classId, fileIndex, checker, addItem, funcDeclItems);
    return;
  }

  if (
    ts.isInterfaceDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isEnumDeclaration(stmt)
  ) {
    addItem(
      {
        name: stmt.name.text,
        fileIndex,
        line,
        kind: 'type',
        parentLocalId: undefined,
        exported,
        takesSelf: false,
        isLifecycle: false,
        holdsNothing: false,
      },
      stmt,
      stmt.name,
    );
    return;
  }

  if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) {
    const fnId = addItem(
      {
        name: stmt.name.text,
        fileIndex,
        line,
        kind: 'function',
        parentLocalId: undefined,
        exported,
        takesSelf: false,
        isLifecycle: false,
        holdsNothing: false,
      },
      stmt,
      stmt.name,
    );
    funcDeclItems.push({ node: stmt, itemId: fnId, parentClassId: undefined, fileIndex });
    return;
  }

  if (!ts.isVariableStatement(stmt)) return;

  for (const decl of stmt.declarationList.declarations) {
    if (!ts.isIdentifier(decl.name)) continue;
    const init = decl.initializer;
    if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      const fnId = addItem(
        {
          name: decl.name.text,
          fileIndex,
          line: lineOf(sf, decl),
          kind: 'function',
          parentLocalId: undefined,
          exported,
          takesSelf: false,
          isLifecycle: false,
          holdsNothing: false,
        },
        decl,
        decl.name,
      );
      itemByDecl.set(init, fnId);
      funcDeclItems.push({ node: init, itemId: fnId, parentClassId: undefined, fileIndex });
    } else if (init !== undefined && ts.isClassExpression(init)) {
      const classId = addItem(
        {
          name: decl.name.text,
          fileIndex,
          line: lineOf(sf, decl),
          kind: 'type',
          parentLocalId: undefined,
          exported,
          takesSelf: false,
          isLifecycle: false,
          holdsNothing: false,
        },
        decl,
        decl.name,
      );
      itemByDecl.set(init, classId);
      collectClassMembers(sf, init, decl.name.text, classId, fileIndex, checker, addItem, funcDeclItems);
    } else {
      addItem(
        {
          name: decl.name.text,
          fileIndex,
          line: lineOf(sf, decl),
          kind: 'constant',
          parentLocalId: undefined,
          exported,
          takesSelf: false,
          isLifecycle: false,
          holdsNothing: false,
        },
        decl,
        decl.name,
      );
    }
  }
}

interface RefExtractContext {
  readonly rootDir: string;
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly files: readonly SerializedFile[];
  readonly items: readonly SerializedItem[];
  readonly itemByDecl: ReadonlyMap<ts.Node, number>;
  readonly wrappers: readonly SerializedWrapper[];
  readonly checker: ts.TypeChecker;
  readonly resolveSymbolToItem: (sym: ts.Symbol | undefined) => number | undefined;
  readonly pathAliases: PathAliasTable | undefined;
  readonly extensions: readonly string[];
}

function collectImportsRefsAndMetrics(ctx: RefExtractContext): {
  readonly imports: SerializedImport[];
  readonly references: SerializedReference[];
  readonly slopFindings: SerializedSlopFinding[];
  readonly functions: SerializedFunctionMetric[];
} {
  const {
    rootDir,
    sourceFiles,
    files,
    items,
    itemByDecl,
    wrappers,
    checker,
    resolveSymbolToItem,
    pathAliases,
    extensions,
  } = ctx;
  const imports: SerializedImport[] = [];
  const references: SerializedReference[] = [];
  const slopFindings: SerializedSlopFinding[] = [];
  const functions: SerializedFunctionMetric[] = [];

  for (let fileIndex = 0; fileIndex < sourceFiles.length; fileIndex += 1) {
    const sf = sourceFiles[fileIndex]!;
    const fileInfo = files[fileIndex]!;
    const isTest = fileInfo.isTest;
    slopFindings.push(...scanFileSlop(sf, fileIndex, fileInfo.path, isTest));
    functions.push(...scanFunctionMetrics(sf, fileIndex, isTest));

    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const specifier = stmt.moduleSpecifier.text;
        const pos = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
        const { symbols, typeOnly } = extractImportDetails(stmt);
        imports.push({
          fileIndex,
          line: pos.line + 1,
          column: pos.character + 1,
          specifier,
          targetRelPath: resolveImportRelPath(rootDir, sf.fileName, specifier, pathAliases, extensions),
          symbols,
          typeOnly,
          isWildcardReExport: false,
          isTest,
        });
      } else if (
        ts.isExportDeclaration(stmt) &&
        stmt.moduleSpecifier !== undefined &&
        ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        const specifier = stmt.moduleSpecifier.text;
        const pos = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
        imports.push({
          fileIndex,
          line: pos.line + 1,
          column: pos.character + 1,
          specifier,
          targetRelPath: resolveImportRelPath(rootDir, sf.fileName, specifier, pathAliases, extensions),
          symbols: extractReExportSymbols(stmt),
          typeOnly: stmt.isTypeOnly,
          isWildcardReExport: stmt.exportClause === undefined,
          isTest,
        });
      }
    }

    const walkRefs = (node: ts.Node, holderId: number | undefined, inTypePos: boolean): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;

      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length >= 1 &&
        ts.isStringLiteral(node.arguments[0]!)
      ) {
        const specifier = node.arguments[0]!.text;
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        imports.push({
          fileIndex,
          line: pos.line + 1,
          column: pos.character + 1,
          specifier,
          targetRelPath: resolveImportRelPath(rootDir, sf.fileName, specifier, pathAliases, extensions),
          symbols: ['(dynamic)'],
          typeOnly: false,
          isWildcardReExport: false,
          isTest,
        });
      }

      const nextHolder = itemByDecl.get(node) ?? holderId;
      const nextInType =
        inTypePos ||
        ts.isTypeNode(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node);

      if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && !isDeclarationNameNode(node)) {
        const targetId = resolveSymbolToItem(checker.getSymbolAtLocation(node));
        if (targetId !== undefined && targetId !== nextHolder) {
          const targetItem = items[targetId]!;
          const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const copies =
            targetItem.kind === 'field' || isAccessorWrapper(wrappers, targetId)
              ? isReadOnlyUse(node, checker)
              : false;
          references.push({
            fileIndex,
            line: pos.line + 1,
            column: pos.character + 1,
            holderLocalId: nextHolder,
            targetLocalId: targetId,
            copies,
            typeOnly: nextInType,
            isTest,
          });
        }
      }

      ts.forEachChild(node, (child) => walkRefs(child, nextHolder, nextInType));
    };

    walkRefs(sf, undefined, false);
  }

  return { imports, references, slopFindings, functions };
}

function collectClassMembers(
  sf: ts.SourceFile,
  cls: ts.ClassLikeDeclaration,
  className: string,
  classId: number,
  fileIndex: number,
  checker: ts.TypeChecker,
  addItem: (
    item: Omit<SerializedItem, 'localId'>,
    decl: ts.Node,
    symNode?: ts.Node,
  ) => number,
  funcDeclItems: {
    node: ts.FunctionLikeDeclaration;
    itemId: number;
    parentClassId: number | undefined;
    fileIndex: number;
  }[],
): void {
  for (const member of cls.members) {
    const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
    const line = lineOf(sf, member);

    if (ts.isConstructorDeclaration(member)) {
      const ctorId = addItem(
        {
          name: `${className}.constructor`,
          fileIndex,
          line,
          kind: 'function',
          parentLocalId: classId,
          exported: false,
          takesSelf: true,
          isLifecycle: true,
          holdsNothing: false,
        },
        member,
      );
      funcDeclItems.push({
        node: member,
        itemId: ctorId,
        parentClassId: classId,
        fileIndex,
      });

      // Parameter properties: `constructor(private readonly items: Item[])`
      for (const param of member.parameters) {
        const isParamProp =
          hasModifier(param, ts.SyntaxKind.PublicKeyword) ||
          hasModifier(param, ts.SyntaxKind.PrivateKeyword) ||
          hasModifier(param, ts.SyntaxKind.ProtectedKeyword) ||
          hasModifier(param, ts.SyntaxKind.ReadonlyKeyword);
        if (isParamProp && ts.isIdentifier(param.name)) {
          addItem(
            {
              name: `${className}.${param.name.text}`,
              fileIndex,
              line: lineOf(sf, param),
              kind: 'field',
              parentLocalId: classId,
              exported: false,
              takesSelf: false,
              isLifecycle: false,
              holdsNothing: isMarkerField(param.name.text, param.type),
            },
            param,
            param.name,
          );
        }
      }
    } else if (ts.isPropertyDeclaration(member)) {
      const propName = propertyNameText(member.name);
      if (propName === undefined) continue;
      if (
        member.initializer !== undefined &&
        (ts.isArrowFunction(member.initializer) ||
          ts.isFunctionExpression(member.initializer))
      ) {
        const methodId = addItem(
          {
            name: `${className}.${propName}`,
            fileIndex,
            line,
            kind: 'function',
            parentLocalId: classId,
            exported: false,
            takesSelf: !isStatic,
            isLifecycle: LIFECYCLE_METHODS.has(propName),
            holdsNothing: false,
          },
          member,
          member.name,
        );
        funcDeclItems.push({
          node: member.initializer,
          itemId: methodId,
          parentClassId: classId,
          fileIndex,
        });
      } else {
        addItem(
          {
            name: `${className}.${propName}`,
            fileIndex,
            line,
            kind: 'field',
            parentLocalId: classId,
            exported: false,
            takesSelf: false,
            isLifecycle: false,
            holdsNothing: isMarkerField(propName, member.type),
          },
          member,
          member.name,
        );
      }
    } else if (
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      const propName = propertyNameText(member.name);
      if (propName === undefined) continue;
      const isComputedSymbol =
        ts.isComputedPropertyName(member.name) &&
        member.name.expression.getText(sf).includes('Symbol.');
      const methodId = addItem(
        {
          name: `${className}.${propName}`,
          fileIndex,
          line,
          kind: 'function',
          parentLocalId: classId,
          exported: false,
          takesSelf: !isStatic,
          isLifecycle: isComputedSymbol || LIFECYCLE_METHODS.has(propName),
          holdsNothing: false,
        },
        member,
        member.name,
      );
      funcDeclItems.push({
        node: member,
        itemId: methodId,
        parentClassId: classId,
        fileIndex,
      });
    }
  }
  void checker;
}

/**
 * Detects whether a function or method is a trivial wrapper:
 * - Accessor: `return this.field` (getter) or `this.field = value` (setter)
 * - Forwarder: `return target(...args)` or `return this.field.target(...args)`
 */
function detectWrapper(
  fn: ts.FunctionLikeDeclaration,
  parentClassId: number | undefined,
  checker: ts.TypeChecker,
  resolveSymbolToItem: (sym: ts.Symbol | undefined) => number | undefined,
  items: readonly SerializedItem[],
): Wrapper | undefined {
  if (fn.body === undefined) return undefined;
  if (ts.isConstructorDeclaration(fn)) return undefined;

  let singleExpr: ts.Expression | undefined;
  if (ts.isBlock(fn.body)) {
    if (fn.body.statements.length !== 1) return undefined;
    const stmt = fn.body.statements[0]!;
    if (ts.isReturnStatement(stmt) && stmt.expression !== undefined) {
      singleExpr = stmt.expression;
    } else if (ts.isExpressionStatement(stmt)) {
      singleExpr = stmt.expression;
    } else {
      return undefined;
    }
  } else {
    singleExpr = fn.body;
  }

  singleExpr = unwrapParensAndAwait(singleExpr);

  // Case 1: Getter / Accessor (`return this.field`)
  if (
    parentClassId !== undefined &&
    ts.isPropertyAccessExpression(singleExpr) &&
    singleExpr.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    const fieldId = resolveSymbolToItem(checker.getSymbolAtLocation(singleExpr.name));
    if (fieldId !== undefined && items[fieldId]?.kind === 'field') {
      const fieldType = checker.getTypeAtLocation(singleExpr);
      const isCopy = isPrimitiveOrReadonlyType(fieldType, checker);
      return {
        kind: 'accessor',
        lent: isCopy ? [] : [fieldId],
        copied: isCopy ? [fieldId] : [],
        toRead: true,
      };
    }
  }

  // Case 2: Setter (`this.field = param`)
  if (
    parentClassId !== undefined &&
    ts.isBinaryExpression(singleExpr) &&
    singleExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(singleExpr.left) &&
    singleExpr.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isIdentifier(singleExpr.right)
  ) {
    const fieldId = resolveSymbolToItem(
      checker.getSymbolAtLocation(singleExpr.left.name),
    );
    if (fieldId !== undefined && items[fieldId]?.kind === 'field') {
      return {
        kind: 'accessor',
        lent: [fieldId],
        copied: [],
        toRead: false,
      };
    }
  }

  // Case 3: Forwarder (`return target(a, b)` or `return this.inner.target(a, b)`)
  if (ts.isCallExpression(singleExpr)) {
    const argsAreSimple = singleExpr.arguments.every(
      (arg) =>
        ts.isIdentifier(arg) ||
        (ts.isSpreadElement(arg) && ts.isIdentifier(arg.expression)),
    );
    if (!argsAreSimple) return undefined;

    const callee = singleExpr.expression;
    let targetSym: ts.Symbol | undefined;
    const fields: number[] = [];

    if (ts.isIdentifier(callee)) {
      targetSym = checker.getSymbolAtLocation(callee);
    } else if (ts.isPropertyAccessExpression(callee)) {
      targetSym = checker.getSymbolAtLocation(callee.name);
      // Collect `this.<field>` chain if present
      let recv: ts.Expression = callee.expression;
      while (ts.isPropertyAccessExpression(recv)) {
        if (recv.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const fieldId = resolveSymbolToItem(checker.getSymbolAtLocation(recv.name));
          if (fieldId !== undefined && items[fieldId]?.kind === 'field') {
            fields.push(fieldId);
          }
          break;
        }
        recv = recv.expression;
      }
    }

    const targetId = resolveSymbolToItem(targetSym);
    if (targetId !== undefined && items[targetId]?.kind === 'function') {
      return {
        kind: 'forwarder',
        target: targetId,
        fields,
      };
    }
  }

  return undefined;
}

/**
 * Determines whether an access to a field (or accessor call) only reads a
 * value without mutating, writing, deleting, or invoking mutating methods.
 */
function isReadOnlyUse(node: ts.Identifier | ts.PrivateIdentifier, checker: ts.TypeChecker): boolean {
  let expr: ts.Node = node;
  if (
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.name === node
  ) {
    expr = node.parent;
  }

  // If this is a getter/accessor call `obj.getItems()`, inspect what the caller does with the result.
  if (ts.isCallExpression(expr.parent) && expr.parent.expression === expr) {
    expr = expr.parent;
  }

  const parent = expr.parent;
  if (parent === undefined) return true;

  // Direct assignment: `obj.field = ...` or `obj.field += ...`
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === expr &&
    isAssignmentOperator(parent.operatorToken.kind)
  ) {
    return false;
  }

  // Prefix/postfix ++ / -- or `delete obj.field`
  if (
    ts.isPrefixUnaryExpression(parent) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return false;
  }
  if (ts.isPostfixUnaryExpression(parent)) {
    return false;
  }
  if (ts.isDeleteExpression(parent)) {
    return false;
  }

  // Indexed write: `obj.field[i] = ...`, `delete obj.field[i]`, `obj.field[i]++`
  if (ts.isElementAccessExpression(parent) && parent.expression === expr) {
    const gp = parent.parent;
    if (
      gp !== undefined &&
      ((ts.isBinaryExpression(gp) &&
        gp.left === parent &&
        isAssignmentOperator(gp.operatorToken.kind)) ||
        ts.isDeleteExpression(gp) ||
        ts.isPostfixUnaryExpression(gp) ||
        (ts.isPrefixUnaryExpression(gp) &&
          (gp.operator === ts.SyntaxKind.PlusPlusToken ||
            gp.operator === ts.SyntaxKind.MinusMinusToken)))
    ) {
      return false;
    }
    return true;
  }

  // Chained property access or method call on the field: `obj.field.push(x)` / `obj.field.x = 1`
  if (ts.isPropertyAccessExpression(parent) && parent.expression === expr) {
    const memberName = parent.name.text;
    const gp = parent.parent;

    // `obj.field.prop = ...`
    if (
      gp !== undefined &&
      ((ts.isBinaryExpression(gp) &&
        gp.left === parent &&
        isAssignmentOperator(gp.operatorToken.kind)) ||
        ts.isDeleteExpression(gp) ||
        ts.isPostfixUnaryExpression(gp))
    ) {
      return false;
    }

    // Method call `obj.field.method(...)`
    if (gp !== undefined && ts.isCallExpression(gp) && gp.expression === parent) {
      if (MUTATING_COLLECTION_METHODS.has(memberName)) return false;
      if (READONLY_COLLECTION_METHODS.has(memberName)) return true;
      // Calling a method on a primitive (string/number) is always read-only;
      // calling an arbitrary method on a mutable object field reaches into it.
      const recvType = checker.getTypeAtLocation(expr);
      return isPrimitiveOrReadonlyType(recvType, checker);
    }

    // Pure property read like `obj.field.length` or `obj.field.size`
    if (memberName === 'length' || memberName === 'size') {
      return true;
    }
  }

  return true;
}

function isPrimitiveOrReadonlyType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const primitiveFlags =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.VoidLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Never |
    ts.TypeFlags.EnumLike;

  if ((type.flags & primitiveFlags) !== 0) return true;
  if (type.isUnion()) {
    return type.types.every((t) => isPrimitiveOrReadonlyType(t, checker));
  }
  const typeStr = checker.typeToString(type);
  if (
    typeStr.startsWith('readonly ') ||
    typeStr.startsWith('Readonly<') ||
    typeStr.startsWith('ReadonlyArray<') ||
    typeStr.startsWith('ReadonlyMap<') ||
    typeStr.startsWith('ReadonlySet<')
  ) {
    return true;
  }
  return false;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function isAccessorWrapper(
  wrappers: readonly SerializedWrapper[],
  itemId: number,
): boolean {
  return wrappers.some(
    (w) => w.localId === itemId && w.wrapper.kind === 'accessor',
  );
}

function isDeclarationNameNode(node: ts.Identifier | ts.PrivateIdentifier): boolean {
  const p = node.parent;
  if (p === undefined) return false;
  if (
    (ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isTypeParameterDeclaration(p) ||
      ts.isBindingElement(p) ||
      ts.isImportClause(p) ||
      ts.isImportSpecifier(p) ||
      ts.isNamespaceImport(p) ||
      ts.isExportSpecifier(p)) &&
    p.name === node
  ) {
    return true;
  }
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  return false;
}

function unwrapParensAndAwait(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isAwaitExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function resolveImportRelPath(
  rootDir: string,
  fromFile: string,
  specifier: string,
  pathAliases: PathAliasTable | undefined,
  extensions: readonly string[],
): string | undefined {
  const resolved = resolveModuleSpecifier(
    fromFile,
    specifier,
    pathAliases,
    extensions,
  );
  if (resolved === undefined) return undefined;
  return toPosix(relative(rootDir, resolved));
}

function extractImportDetails(stmt: ts.ImportDeclaration): {
  symbols: string[];
  typeOnly: boolean;
} {
  const clause = stmt.importClause;
  if (clause === undefined) {
    return { symbols: ['(side-effect)'], typeOnly: false };
  }
  const symbols: string[] = [];
  let allTypeOnly = clause.isTypeOnly;
  if (clause.name !== undefined) {
    symbols.push('default');
  }
  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (ts.isNamespaceImport(bindings)) {
      symbols.push('*');
    } else if (ts.isNamedImports(bindings)) {
      if (bindings.elements.length > 0 && !clause.isTypeOnly) {
        allTypeOnly = bindings.elements.every((el) => el.isTypeOnly);
      }
      for (const el of bindings.elements) {
        symbols.push(el.propertyName?.text ?? el.name.text);
      }
    }
  }
  return { symbols, typeOnly: allTypeOnly };
}

function extractReExportSymbols(stmt: ts.ExportDeclaration): string[] {
  if (stmt.exportClause === undefined) return ['*'];
  if (ts.isNamespaceExport(stmt.exportClause)) return ['*'];
  return stmt.exportClause.elements.map(
    (el) => el.propertyName?.text ?? el.name.text,
  );
}

function moduleSegmentsFor(relPath: string, pkgRelDir: string): string[] {
  const insidePkg =
    pkgRelDir.length > 0 && relPath.startsWith(`${pkgRelDir}/`)
      ? relPath.slice(pkgRelDir.length + 1)
      : relPath;
  const stripped = insidePkg.replace(
    /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|tsrx)$/,
    '',
  );
  const rawSegments = stripped.split('/').filter(Boolean);
  // Treat `src/` as the transparent package source root (mirrors Rust `src/lib.rs`).
  const segments =
    rawSegments[0] === 'src' ? rawSegments.slice(1) : rawSegments;
  // Treat `index` as the enclosing directory's module (mirrors Rust `mod.rs`).
  if (segments.length > 0 && segments[segments.length - 1] === 'index') {
    segments.pop();
  }
  return segments;
}

function isTestFilePath(relPath: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|tests|e2e|laws)\//.test(relPath) ||
    /\.(?:test|spec|typecheck|laws|config)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|tsrx)$/.test(
      relPath,
    )
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods?.some((m) => m.kind === kind) ?? false;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function isMarkerField(name: string, typeNode: ts.TypeNode | undefined): boolean {
  if (name.startsWith('_brand') || name.startsWith('__brand') || name === '_phantom') {
    return true;
  }
  if (typeNode !== undefined && typeNode.kind === ts.SyntaxKind.NeverKeyword) {
    return true;
  }
  return false;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
