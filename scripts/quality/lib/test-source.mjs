import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SKIP_HELPER = fileURLToPath(new URL('../../../src/test/declaredSkip.ts', import.meta.url));
const TEST_APIS = new Set(['it', 'test', 'describe', 'suite']);
const TEST_MODIFIERS = new Set(['it', 'test', 'describe', 'suite', 'each', 'for', 'extend',
  'fails', 'fail', 'concurrent', 'sequential', 'parallel', 'serial', 'skip', 'only', 'todo', 'skipIf', 'runIf']);

/** Parse syntax and local bindings only. No test, import, or config code executes. */
export function inspectTestSource(file, text = fs.readFileSync(file, 'utf8')) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const program = ts.createProgram([file], { noLib: true, noResolve: true, allowJs: true }, {
    getSourceFile: (name) => name === file ? source : undefined,
    getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => path.dirname(file),
    getDirectories: () => [], fileExists: (name) => name === file,
    readFile: (name) => name === file ? text : undefined,
    getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  });
  const checker = program.getTypeChecker();
  const unwrap = (node) => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
    return node;
  };
  const declarationOf = (node) => checker.getSymbolAtLocation(node)?.declarations?.[0];
  function constant(node, seen = new Set()) {
    node = unwrap(node);
    if (!node || seen.has(node)) return undefined;
    seen = new Set(seen).add(node);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = constant(node.left, seen), right = constant(node.right, seen);
      return typeof left === 'string' && typeof right === 'string' ? left + right : undefined;
    }
    if (ts.isIdentifier(node)) {
      const declaration = declarationOf(node);
      if (declaration && ts.isVariableDeclaration(declaration)) return constant(declaration.initializer, seen);
    }
    return undefined;
  }
  function imported(declaration) {
    let parent = declaration;
    while (parent && !ts.isImportDeclaration(parent)) parent = parent.parent;
    return parent && ts.isStringLiteral(parent.moduleSpecifier) ? parent.moduleSpecifier.text : undefined;
  }
  function helperImport(specifier) {
    if (!specifier) return false;
    const target = specifier.startsWith('@/') ? path.resolve(path.dirname(SKIP_HELPER), '..', specifier.slice(2))
      : path.resolve(path.dirname(file), specifier);
    return [SKIP_HELPER, SKIP_HELPER.replace(/\.ts$/, ''), SKIP_HELPER.replace(/\.ts$/, '.js')].includes(target);
  }
  function api(node, seen = new Set()) {
    node = unwrap(node);
    if (!node || seen.has(node)) return null;
    seen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const declaration = declarationOf(node);
      if (!declaration) return TEST_APIS.has(node.text) ? [node.text] : null;
      if (ts.isImportSpecifier(declaration)) {
        const name = (declaration.propertyName ?? declaration.name).text;
        const from = imported(declaration);
        // Local fixtures re-export test/it too (the journey uses appTest.extend).
        // Treat those imports conservatively as test APIs without executing them.
        if (TEST_APIS.has(name)) return [name];
        if (name === 'skipWhen' && helperImport(from)) return ['skipWhen'];
      }
      if (ts.isNamespaceImport(declaration) && imported(declaration) === 'vitest') return ['vitest'];
      if (ts.isVariableDeclaration(declaration)) return api(declaration.initializer, seen);
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
        const owner = declaration.parent.parent;
        const base = ts.isVariableDeclaration(owner) ? api(owner.initializer, seen) : null;
        const key = declaration.propertyName ?? declaration.name;
        if (base && (ts.isIdentifier(key) || ts.isStringLiteral(key))) return [...base, key.text];
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = api(node.expression, seen);
      const member = ts.isPropertyAccessExpression(node) ? node.name.text : constant(node.argumentExpression);
      if (!base || member === undefined) return null;
      return base[0] === 'vitest' && TEST_APIS.has(member) ? [member] : [...base, member];
    }
    // each/for/extend chains return the same test API; inspect only the final invocation.
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) return api(node.expression ?? node.tag, seen);
    return null;
  }
  const declarations = [];
  const markers = [];
  const skips = [];
  const calls = new Map();
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const chain = api(node.expression);
      const first = node.arguments[0];
      const callback = [...node.arguments].reverse().find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      if (chain && TEST_APIS.has(chain[0]) && chain.every((part) => TEST_MODIFIERS.has(part))
          && callback && first !== callback) {
        const test = {
          node, callback, title: constant(first), chain,
          start: node.getStart(source), headerEnd: callback.getStart(source), end: node.end,
          isSuite: chain.some((part) => ['describe', 'suite'].includes(part)), skips: [],
        };
        declarations.push(test);
        calls.set(node, test);
      }
      const parent = node.parent;
      const continued = (ts.isCallExpression(parent) || ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
        && parent.expression === node;
      if (chain && chain.some((part) => part === 'fail' || part === 'fails') && !continued) markers.push({ node, chain });
      if (chain?.length === 1 && chain[0] === 'skipWhen') skips.push({ node, name: constant(first) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  function enclosing(node, allowSelf = false) {
    for (let at = allowSelf ? node : node.parent; at; at = at.parent) if (calls.has(at)) return calls.get(at);
    return undefined;
  }
  for (const test of declarations) {
    const suites = [];
    for (let ancestor = enclosing(test.node); ancestor; ancestor = enclosing(ancestor.node)) {
      if (ancestor.isSuite) suites.unshift(ancestor.title);
    }
    test.fullTitle = [...suites, test.title].every((title) => typeof title === 'string')
      ? [...suites, test.title].join(' > ') : undefined;
  }
  for (const skip of skips) {
    const owner = enclosing(skip.node);
    // A helper in a suite hook or a different test cannot authorize this item.
    if (owner && !owner.isSuite && skip.name) owner.skips.push(skip.name);
  }
  const expectedFailures = markers.map(({ node, chain }) => {
    const owner = enclosing(node, true);
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    return {
      line: position.line + 1, column: position.character + 1,
      title: owner?.title, fullTitle: owner?.fullTitle,
      previousLine: text.split('\n')[position.line - 1] ?? '',
      kind: chain.includes('fails') ? 'vitest' : 'playwright',
    };
  });
  return {
    expectedFailures,
    // Position comes from Vitest's source map. Match the declaration header, not a
    // whole file, a title pattern, or another test with the same declared tag.
    declaredSkipsAt(location) {
      if (!location || !Number.isInteger(location.line) || !Number.isInteger(location.column)) return [];
      let offset;
      try { offset = source.getPositionOfLineAndCharacter(location.line - 1, location.column - 1); } catch { return []; }
      return declarations.filter((test) => !test.isSuite && offset >= test.start && offset <= test.headerEnd)
        .flatMap((test) => test.skips);
    },
  };
}
