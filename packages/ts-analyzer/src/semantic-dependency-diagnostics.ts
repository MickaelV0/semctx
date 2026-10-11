import ts from "typescript";
import { resolve } from "node:path";
import { extractionContext, unwrapStaticExpression, type CompilerInputSnapshot } from "./ts-symbols";

type Context = { program: ts.Program; retained: Set<string> };
const contexts = new WeakMap<CompilerInputSnapshot, Context>();
const key = (path: string): string => {
  const normalized = resolve(path).replaceAll("\\", "/");
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
};

/** Semantic refusal only: never invent dependency edges or read uncaptured repository sources. */
export function inspectSemanticDependencies(source: ts.SourceFile, snapshot?: CompilerInputSnapshot, sourcePath = source.fileName): string[] {
  const reasons = new Set<string>();
  if (source.referencedFiles.length > 0) reasons.add("SOURCE_REFERENCE_PATH_UNSUPPORTED");
  const sdk = ts as unknown as { isIntrinsicJsxName(name: string): boolean };
  let needsChecker = false;
  const asyncOwner = (node: ts.Node): boolean => {
    for (let owner: ts.Node | undefined = node.parent; owner !== undefined; owner = owner.parent) if (ts.isFunctionLike(owner)) {
      return ts.canHaveModifiers(owner) && ts.getModifiers(owner)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
    }
    return false;
  };
  const inspectSyntax = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using) !== 0) reasons.add("SOURCE_DISPOSAL_UNSUPPORTED");
    if (ts.isElementAccessExpression(node) || ts.isComputedPropertyName(node)) needsChecker = true;
    if (ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.PlusEqualsToken].includes(node.operatorToken.kind))
      || (ts.isReturnStatement(node) && asyncOwner(node))
      || (ts.isArrowFunction(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword))) needsChecker = true;
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === "register") needsChecker = true;
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && ["Proxy", "revocable"].includes(node.text)) needsChecker = true;
    if (ts.isDecorator(node)) reasons.add("SOURCE_DECORATOR_UNSUPPORTED");
    if (ts.isNewExpression(node)) needsChecker = true;
    if (ts.isForOfStatement(node) || ts.isSpreadElement(node)) needsChecker = true;
    if (ts.isAwaitExpression(node) || (ts.isYieldExpression(node) && node.asteriskToken !== undefined)
      || (ts.isBinaryExpression(node) && [ts.SyntaxKind.InstanceOfKeyword, ts.SyntaxKind.EqualsToken].includes(node.operatorToken.kind))) needsChecker = true;
    if (ts.isParameter(node) && ts.isArrayBindingPattern(node.name)) needsChecker = true;
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && ["Reflect", "construct"].includes(node.text)) needsChecker = true;
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && ["setTimeout", "setInterval"].includes(node.text)) needsChecker = true;
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) reasons.add("SOURCE_ACCESSOR_UNSUPPORTED");
    if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name)) needsChecker = true;
    if (ts.isExportDeclaration(node) || (ts.isVariableStatement(node)
      && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))) needsChecker = true;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      const name = ts.isIdentifier(tag) ? tag.text : ts.isJsxNamespacedName(tag) ? `${tag.namespace.text}:${tag.name.text}` : undefined;
      if (name === undefined || !sdk.isIntrinsicJsxName(name)) reasons.add("SOURCE_JSX_COMPONENT_UNSUPPORTED");
    }
    if ((ts.isPropertyAccessExpression(node) && ["call", "apply", "bind", "constructor"].includes(node.name.text))
      || (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "constructor")) needsChecker = true;
    if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) needsChecker = true;
    ts.forEachChild(node, inspectSyntax);
  };
  inspectSyntax(source);
  if (!needsChecker) return [...reasons].sort();
  const inputs = snapshot ?? new Map([[source.fileName, source.text]]);
  let context = contexts.get(inputs);
  if (context === undefined) {
    const paths = [...inputs.keys()].filter(path => /\.[cm]?[jt]sx?$/.test(path));
    context = { program: extractionContext.createProgram(paths, inputs), retained: new Set(paths.map(key)) };
    contexts.set(inputs, context);
  }
  const { program, retained } = context;
  const bound = program.getSourceFile(sourcePath);
  if (bound === undefined) return ["SOURCE_SEMANTIC_SOURCE_UNAVAILABLE"];
  const checker = program.getTypeChecker();
  const internal = (node: ts.Node): boolean => retained.has(key(node.getSourceFile().fileName)) && !program.isSourceFileDefaultLibrary(node.getSourceFile());
  const declarations = (expression: ts.Expression): readonly ts.Declaration[] => {
    let symbol = checker.getSymbolAtLocation(unwrapStaticExpression(expression));
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.getDeclarations() ?? [];
  };
  const destructuredOrigin = (declaration: ts.Declaration, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(declaration)) return false;
    seen.add(declaration);
    if (ts.isBindingElement(declaration)) return true;
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return false;
    const initializer = unwrapStaticExpression(declaration.initializer);
    return ts.isIdentifier(initializer) && declarations(initializer).some(origin => destructuredOrigin(origin, seen));
  };
  const potentiallyCallable = (type: ts.Type): boolean => {
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return true;
    if (type.isUnionOrIntersection()) return type.types.some(potentiallyCallable);
    return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
  };
  const moduleSymbol = checker.getSymbolAtLocation(bound);
  if (moduleSymbol !== undefined) for (let exported of checker.getExportsOfModule(moduleSymbol)) {
    if ((exported.flags & ts.SymbolFlags.Alias) !== 0) exported = checker.getAliasedSymbol(exported);
    const origins = exported.getDeclarations() ?? [];
    if (origins.some(origin => internal(origin) && destructuredOrigin(origin))
      && potentiallyCallable(checker.getTypeOfSymbolAtLocation(exported, origins[0] ?? bound))) {
      reasons.add("SOURCE_DESTRUCTURED_CALLABLE_EXPORT_UNSUPPORTED");
    }
    if (origins.some(origin => internal(origin) && ts.isVariableDeclaration(origin)
      && (origin.initializer === undefined || !(ts.isArrowFunction(origin.initializer) || ts.isFunctionExpression(origin.initializer))))
      && potentiallyCallable(checker.getTypeOfSymbolAtLocation(exported, origins[0] ?? bound))) {
      reasons.add("SOURCE_CALLABLE_EXPORT_UNSUPPORTED");
    }
  }
  const internalCallable = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const receiver = unwrapStaticExpression(expression);
    if (seen.has(receiver)) return false;
    seen.add(receiver);
    const type = checker.getTypeAtLocation(receiver);
    if ([...type.getCallSignatures(), ...type.getConstructSignatures()].some(signature => {
      const declaration = signature.getDeclaration(); return declaration !== undefined && internal(declaration);
    })) return true;
    return declarations(receiver).some(declaration => ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
      && internalCallable(declaration.initializer, seen));
  };
  const functionHelper = (node: ts.PropertyAccessExpression): boolean => {
    if (!["call", "apply", "bind"].includes(node.name.text)) return false;
    const receiver = unwrapStaticExpression(node.expression);
    const symbol = checker.getSymbolAtLocation(node) ?? checker.getPropertyOfType(checker.getTypeAtLocation(receiver), node.name.text);
    return (symbol?.getDeclarations() ?? []).some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && ts.isInterfaceDeclaration(declaration.parent) && ["Function", "CallableFunction", "NewableFunction"].includes(declaration.parent.name.text)
      && ["call", "apply", "bind"].includes(symbol!.getName())) && internalCallable(receiver);
  };
  const intrinsicConstructor = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean => {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
    if (name !== "constructor") return false;
    const receiver = unwrapStaticExpression(node.expression);
    const type = checker.getTypeAtLocation(receiver);
    if (type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0) return false;
    const symbol = checker.getSymbolAtLocation(node) ?? checker.getPropertyOfType(type, name);
    return (symbol?.getDeclarations() ?? []).some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "Object" && symbol!.getName() === "constructor");
  };
  const sdkValue = (expression: ts.Expression, seen = new Set<ts.Node>()): ts.Symbol | undefined => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value) || !(ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))) return undefined;
    seen.add(value);
    const origins = declarations(value);
    if (origins.length > 0 && origins.every(origin => program.isSourceFileDefaultLibrary(origin.getSourceFile()))) {
      let symbol = checker.getSymbolAtLocation(value);
      if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
      return symbol;
    }
    // An annotation or returned SDK type is not the runtime constructor's origin.
    // Only immutable transparent value aliases can preserve a proven SDK binding.
    for (const origin of origins) if (ts.isVariableDeclaration(origin) && ts.isVariableDeclarationList(origin.parent)
      && (origin.parent.flags & ts.NodeFlags.Const) !== 0 && origin.initializer !== undefined) {
      const symbol = sdkValue(origin.initializer, seen); if (symbol !== undefined) return symbol;
    }
    for (const origin of origins) if (ts.isBindingElement(origin) && ts.isObjectBindingPattern(origin.parent)
      && ts.isVariableDeclaration(origin.parent.parent) && origin.parent.parent.initializer !== undefined
      && ts.isVariableDeclarationList(origin.parent.parent.parent) && (origin.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0
      && sdkValue(origin.parent.parent.initializer, seen) !== undefined) {
      const member = origin.propertyName ?? origin.name;
      if (ts.isIdentifier(member) || ts.isStringLiteral(member)) {
        const symbol = checker.getPropertyOfType(checker.getTypeAtLocation(origin.parent.parent.initializer), member.text);
        if ((symbol?.getDeclarations()?.length ?? 0) > 0 && symbol!.getDeclarations()!.every(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))) return symbol;
      }
    }
    return undefined;
  };
  const sdkConstruction = (symbol: ts.Symbol | undefined): boolean => symbol !== undefined
    && checker.getTypeOfSymbolAtLocation(symbol, symbol.getDeclarations()![0]!).getConstructSignatures().some(signature => {
      const declaration = signature.getDeclaration(); return declaration !== undefined && program.isSourceFileDefaultLibrary(declaration.getSourceFile());
    });
  const primitiveValue = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (ts.isNumericLiteral(value) || ts.isBigIntLiteral(value) || ts.isStringLiteralLike(value) || ts.isVoidExpression(value)
      || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind)) return true;
    if (ts.isIdentifier(value) && value.text === "undefined" && declarations(value).length === 0
      && (checker.getTypeAtLocation(value).flags & ts.TypeFlags.Undefined) !== 0) return true;
    if (ts.isTypeOfExpression(value)) return true;
    if (ts.isTemplateExpression(value)) return value.templateSpans.every(span => primitiveValue(span.expression, new Set(seen)));
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) return primitiveValue(value.left, new Set(seen)) && primitiveValue(value.right, new Set(seen));
    if (ts.isPrefixUnaryExpression(value)) return value.operator === ts.SyntaxKind.ExclamationToken || primitiveValue(value.operand, new Set(seen));
    return declarations(value).some(declaration => ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined && primitiveValue(declaration.initializer, new Set(seen)));
  };
  const constantString = (expression: ts.Expression, seen = new Set<ts.Node>()): string | undefined => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (ts.isStringLiteralLike(value)) return value.text;
    for (const declaration of declarations(value)) if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined) {
      const name = constantString(declaration.initializer, seen); if (name !== undefined) return name;
    }
    return undefined;
  };
  const staticMemberName = (expression: ts.Expression): string | undefined => ts.isPropertyAccessExpression(expression) ? expression.name.text
    : ts.isElementAccessExpression(expression) ? constantString(expression.argumentExpression) : undefined;
  const propertyKey = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (primitiveValue(value)) return true;
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && sdkValue(value.expression)?.getName() === "Symbol") {
      const symbol = sdkValue(value);
      if (symbol !== undefined && (checker.getTypeAtLocation(value).flags & ts.TypeFlags.ESSymbolLike) !== 0) return true;
    }
    return declarations(value).some(declaration => ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined && propertyKey(declaration.initializer, seen));
  };
  const iteratorKey = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && sdkValue(value.expression)?.getName() === "Symbol") {
      return ["iterator", "asyncIterator"].includes(sdkValue(value)?.getName() ?? "");
    }
    return declarations(value).some(origin => {
      if (ts.isVariableDeclaration(origin) && ts.isVariableDeclarationList(origin.parent)
        && (origin.parent.flags & ts.NodeFlags.Const) !== 0 && origin.initializer !== undefined) return iteratorKey(origin.initializer, seen);
      return ts.isBindingElement(origin) && ts.isObjectBindingPattern(origin.parent)
        && ts.isVariableDeclaration(origin.parent.parent) && origin.parent.parent.initializer !== undefined
        && ts.isVariableDeclarationList(origin.parent.parent.parent) && (origin.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0
        && sdkValue(origin.parent.parent.initializer)?.getName() === "Symbol"
        && ["iterator", "asyncIterator"].includes(sdkValue(value)?.getName() ?? "");
    });
  };
  const serviceWorkerLoader = (expression: ts.Expression): boolean => {
    const value = unwrapStaticExpression(expression);
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && staticMemberName(value) === "register"
      && sdkValue(value.expression)?.getName() === "serviceWorker") return true;
    const symbol = sdkValue(expression);
    return symbol?.getName() === "register" && (symbol.getDeclarations() ?? []).some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "ServiceWorkerContainer");
  };
  const proxyFactory = (expression: ts.Expression): boolean => {
    const value = unwrapStaticExpression(expression);
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && staticMemberName(value) === "revocable" && sdkValue(value.expression)?.getName() === "Proxy") return true;
    const symbol = sdkValue(value);
    return symbol?.getName() === "revocable" && (symbol.getDeclarations() ?? []).some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "ProxyConstructor");
  };
  const reflectedInvocation = (expression: ts.Expression): boolean => {
    const symbol = sdkValue(expression);
    return symbol !== undefined && ["apply", "construct"].includes(symbol.getName())
      && (symbol.getDeclarations() ?? []).some(declaration => ts.isModuleBlock(declaration.parent)
        && ts.isModuleDeclaration(declaration.parent.parent) && declaration.parent.parent.name.getText() === "Reflect"
        && program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
  };
  const intrinsicIterable = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (ts.isArrayLiteralExpression(value) || ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) return true;
    if (ts.isNewExpression(value) && ["Array", "Map", "Set"].includes(sdkValue(value.expression)?.getName() ?? "")) return true;
    return declarations(value).some(declaration => ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined && intrinsicIterable(declaration.initializer, seen));
  };
  const literalArray = (expression: ts.Expression, seen = new Set<ts.Node>()): ts.ArrayLiteralExpression | undefined => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (ts.isArrayLiteralExpression(value)) return value;
    for (const declaration of declarations(value)) if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined) {
      const array = literalArray(declaration.initializer, seen); if (array !== undefined) return array;
    }
    return undefined;
  };
  const bindingValue = (pattern: ts.ArrayBindingPattern): ts.Expression | undefined => {
    const parent = pattern.parent;
    if (ts.isVariableDeclaration(parent)) return parent.initializer;
    if (!ts.isBindingElement(parent) || !ts.isArrayBindingPattern(parent.parent) || parent.dotDotDotToken !== undefined) return undefined;
    const outer = bindingValue(parent.parent);
    const array = outer === undefined ? undefined : literalArray(outer);
    const index = parent.parent.elements.indexOf(parent);
    if (array === undefined || array.elements.slice(0, index + 1).some(element => ts.isSpreadElement(element))) return undefined;
    const item = array.elements[index];
    return item === undefined || ts.isOmittedExpression(item) ? undefined : item;
  };
  const asyncValue = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    const isAsync = (node: ts.Node): boolean => ts.canHaveModifiers(node)
      && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return isAsync(value);
    return declarations(value).some(declaration => ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && isAsync(declaration))
      || (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
        && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined && asyncValue(declaration.initializer, seen)));
  };
  const safeAwaitValue = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (ts.isAwaitExpression(value)) return safeAwaitValue(value.expression, seen);
    // Iterable objects remain mutable even behind a const binding; an initializer is
    // not proof that a then override or prototype cannot participate in assimilation.
    if (primitiveValue(value)) return true;
    if (ts.isNewExpression(value) && sdkValue(value.expression)?.getName() === "Promise") return true;
    if (ts.isCallExpression(value)) {
      const callee = unwrapStaticExpression(value.expression);
      if (callee.kind === ts.SyntaxKind.ImportKeyword && value.arguments.length === 1 && ts.isStringLiteralLike(value.arguments[0]!)) return true;
      if (asyncValue(callee)) return true;
      if (ts.isPropertyAccessExpression(callee) && sdkValue(callee.expression)?.getName() === "Promise"
        && sdkValue(callee) !== undefined) {
        if (callee.name.text === "reject") return true;
        if (callee.name.text === "resolve") return value.arguments[0] === undefined || safeAwaitValue(value.arguments[0], seen);
      }
    }
    return declarations(value).some(declaration => ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined && safeAwaitValue(declaration.initializer, seen));
  };
  const timerNames = new Set(["setTimeout", "setInterval"]);
  const sdkTimer = (symbol: ts.Symbol | undefined): boolean => symbol !== undefined && timerNames.has(symbol.getName())
    && (symbol.getDeclarations()?.length ?? 0) > 0 && symbol.getDeclarations()!.every(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
  const timerValue = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (sdkTimer(sdkValue(value))) return true;
    for (const declaration of declarations(value)) {
      if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
        && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined
        && timerValue(declaration.initializer, seen)) return true;
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
      && ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer !== undefined
      && ts.isVariableDeclarationList(declaration.parent.parent.parent) && (declaration.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0) {
      const member = declaration.propertyName ?? declaration.name;
      if ((ts.isIdentifier(member) || ts.isStringLiteral(member)) && sdkTimer(checker.getPropertyOfType(checker.getTypeAtLocation(declaration.parent.parent.initializer), member.text))) return true;
      }
    }
    return false;
  };
  const unsafeHandler = (type: ts.Type): boolean => {
    if ((type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return true;
    if (type.isUnion()) return type.types.some(unsafeHandler);
    if (type.isIntersection() && type.types.some(part => (part.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0)) return true;
    return type.getCallSignatures().length === 0 && !(type.getSymbol()?.getName() === "Function"
      && type.getSymbol()!.getDeclarations()?.every(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())));
  };
  const inspectTimerUse = (node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression): void => {
    const parent = node.parent;
    if (ts.isIdentifier(node) && ((ts.isPropertyAccessExpression(parent) && parent.name === node)
      || (ts.isVariableDeclaration(parent) && parent.name === node) || ts.isBindingElement(parent))) return;
    if (!timerValue(node)) return;
    for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) if (ts.isTypeNode(current)) return;
    let usage: ts.Expression = node;
    while (ts.isParenthesizedExpression(usage.parent) || ts.isAsExpression(usage.parent) || ts.isTypeAssertionExpression(usage.parent)
      || ts.isNonNullExpression(usage.parent) || ts.isSatisfiesExpression(usage.parent)) {
      if (unwrapStaticExpression(usage.parent) !== unwrapStaticExpression(node)) break;
      usage = usage.parent;
    }
    const container = usage.parent;
    if (ts.isVariableDeclaration(container) && container.initializer === usage && ts.isIdentifier(container.name)
      && ts.isVariableDeclarationList(container.parent) && (container.parent.flags & ts.NodeFlags.Const) !== 0) return;
    if (ts.isCallExpression(container) && container.expression === usage && container.arguments[0] !== undefined
      && !unsafeHandler(checker.getTypeAtLocation(unwrapStaticExpression(container.arguments[0])))) return;
    reasons.add("SOURCE_TIMER_EVALUATION_UNSUPPORTED");
  };
  const internalBase = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const base = unwrapStaticExpression(expression);
    if (seen.has(base)) return false;
    seen.add(base);
    if (ts.isConditionalExpression(base)) return internalBase(base.whenTrue, seen) || internalBase(base.whenFalse, seen);
    if ((checker.getTypeAtLocation(base).getSymbol()?.getDeclarations() ?? []).some(declaration =>
      (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) && internal(declaration))) return true;
    return declarations(base).some(declaration => ((ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)
      || ts.isFunctionDeclaration(declaration)) && internal(declaration)) || (ts.isVariableDeclaration(declaration)
      && declaration.initializer !== undefined && internalBase(declaration.initializer, seen)));
  };
  const runtimeProperty = (node: ts.Node): boolean => {
    if (node.getSourceFile().isDeclarationFile) return false;
    for (let owner: ts.Node | undefined = node; owner !== undefined; owner = owner.parent) {
      if (ts.canHaveModifiers(owner) && ts.getModifiers(owner)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return false;
    }
    return true;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node)) return;
    if (runtimeProperty(node) && ((ts.isElementAccessExpression(node) && !propertyKey(node.argumentExpression))
      || (ts.isComputedPropertyName(node) && !propertyKey(node.expression)))) reasons.add("SOURCE_PROPERTY_KEY_UNSUPPORTED");
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && staticMemberName(unwrapStaticExpression(node.left)) === "then" && !primitiveValue(node.right)) reasons.add("SOURCE_THENABLE_MUTATION_UNSUPPORTED");
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const target = unwrapStaticExpression(node.left);
      if (ts.isElementAccessExpression(target) && iteratorKey(target.argumentExpression)) reasons.add("SOURCE_ITERATOR_MUTATION_UNSUPPORTED");
    }
    if ((ts.isBinaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.PlusEqualsToken].includes(node.operatorToken.kind)
      && (!primitiveValue(node.left) || !primitiveValue(node.right)))
      || (ts.isTemplateExpression(node) && node.templateSpans.some(span => !primitiveValue(span.expression)))) reasons.add("SOURCE_COERCION_UNSUPPORTED");
    if ((ts.isReturnStatement(node) && node.expression !== undefined && asyncOwner(node) && !safeAwaitValue(node.expression))
      || (ts.isArrowFunction(node) && !ts.isBlock(node.body) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
        && !safeAwaitValue(node.body))) reasons.add("SOURCE_ASYNC_RETURN_UNSUPPORTED");
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && serviceWorkerLoader(node)) reasons.add("SOURCE_SERVICE_WORKER_LOADER_UNSUPPORTED");
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && proxyFactory(node)) reasons.add("SOURCE_PROXY_UNSUPPORTED");
    if (ts.isAwaitExpression(node) && !safeAwaitValue(node.expression)) reasons.add("SOURCE_AWAIT_UNSUPPORTED");
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
      && !sdkConstruction(sdkValue(node.right))) reasons.add("SOURCE_INSTANCEOF_UNSUPPORTED");
    if (ts.isArrayBindingPattern(node)) {
      const value = bindingValue(node);
      if (value === undefined || !intrinsicIterable(value)) reasons.add("SOURCE_ITERATION_UNSUPPORTED");
    }
    if ((ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isArrayLiteralExpression(node.left) && !intrinsicIterable(node.right))
      || (ts.isYieldExpression(node) && node.asteriskToken !== undefined && (node.expression === undefined || !intrinsicIterable(node.expression)))) reasons.add("SOURCE_ITERATION_UNSUPPORTED");
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && reflectedInvocation(node)) reasons.add("SOURCE_REFLECT_INVOCATION_UNSUPPORTED");
    if ((ts.isForOfStatement(node) || ts.isSpreadElement(node)) && !intrinsicIterable(node.expression)) reasons.add("SOURCE_ITERATION_UNSUPPORTED");
    if (ts.isNewExpression(node)) {
      const origin = sdkValue(node.expression);
      if (!sdkConstruction(origin)) reasons.add("SOURCE_CONSTRUCTION_UNSUPPORTED");
      else if (["Worker", "SharedWorker"].includes(origin!.getName())) reasons.add("SOURCE_WORKER_LOADER_UNSUPPORTED");
      else if (origin!.getName() === "Proxy") reasons.add("SOURCE_PROXY_UNSUPPORTED");
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) inspectTimerUse(node);
    if (ts.isPropertyAccessExpression(node) && functionHelper(node)) reasons.add("SOURCE_FUNCTION_HELPER_UNSUPPORTED");
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && intrinsicConstructor(node)) reasons.add("SOURCE_DYNAMIC_EVALUATION_UNSUPPORTED");
    if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) {
      for (const base of node.types) {
        if (internalBase(base.expression)) reasons.add("SOURCE_INTERNAL_HERITAGE_UNSUPPORTED");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(bound);
  return [...reasons].sort();
}
