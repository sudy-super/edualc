import ts from '../node_modules/typescript/lib/typescript.js';
import { createHash } from 'node:crypto';

const internalModule = /^(?:\/\$bunfs\/root\/|.*\/vendor\/claude-reference\/)(chunk-[^/]+\.js)$/;

function semanticProperty(node) {
  const parent = node.parent;
  if (!parent) return false;
  return (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)
      || ts.isMethodSignature(parent) || ts.isPropertyDeclaration(parent)
      || ts.isPropertySignature(parent) || ts.isGetAccessorDeclaration(parent)
      || ts.isSetAccessorDeclaration(parent)) && parent.name === node)
    || (ts.isBindingElement(parent) && parent.propertyName === node);
}

const signatures = new WeakMap();

export function signature(node) {
  const cached = signatures.get(node);
  if (cached) return cached;
  const identifiers = [], indexes = new Map(), tokens = [];
  function visit(current) {
    tokens.push(current.kind);
    if (ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) {
      if (semanticProperty(current)) tokens.push(['property', current.text]);
      else {
        if (!indexes.has(current.text)) {
          indexes.set(current.text, identifiers.length);
          identifiers.push(current.text);
        }
        tokens.push(['identifier', indexes.get(current.text)]);
      }
    } else if (ts.isStringLiteralLike(current)) {
      tokens.push(internalModule.test(current.text) ? '<internal-module>' : current.text);
    } else if (ts.isNumericLiteral(current) || current.kind === ts.SyntaxKind.RegularExpressionLiteral
      || current.kind === ts.SyntaxKind.BigIntLiteral
      || current.kind === ts.SyntaxKind.TemplateHead
      || current.kind === ts.SyntaxKind.TemplateMiddle
      || current.kind === ts.SyntaxKind.TemplateTail) {
      tokens.push(current.text);
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  const result = { hash: createHash('sha256').update(JSON.stringify(tokens)).digest('hex'), identifiers };
  signatures.set(node, result);
  return result;
}

export function analyzeModule(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse native module ${file}: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, ' ')}`);
  const definitions = new Map(), exports = new Map(), imports = new Map(), literals = new Set();
  function define(name, node) {
    if (definitions.has(name)) throw new Error(`Duplicate native definition ${file}:${name}`);
    definitions.set(name, { name, node, body: node.body, params: node.parameters });
  }
  function exported(statement) {
    return statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  }
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) {
        define(statement.name.text, statement);
        if (exported(statement)) exports.set(statement.name.text, statement.name.text);
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          define(declaration.name.text, declaration.initializer);
          if (exported(statement)) exports.set(declaration.name.text, declaration.name.text);
        }
      }
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      if (statement.moduleSpecifier) throw new Error(`Unsupported native re-export in ${file}`);
      for (const element of statement.exportClause.elements) exports.set(element.name.text, element.propertyName?.text ?? element.name.text);
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      const module = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause.name) imports.set(clause.name.text, { module, export: 'default' });
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) imports.set(clause.namedBindings.name.text, { module, export: '*' });
        else for (const element of clause.namedBindings.elements) imports.set(element.name.text, { module, export: element.propertyName?.text ?? element.name.text });
      }
    }
  }
  function visit(node) {
    if (ts.isStringLiteralLike(node)) literals.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { file, text, source, definitions, exports, imports, literals };
}

export function bytesBefore(text, utf16Index) {
  if (!Number.isInteger(utf16Index) || utf16Index < 0 || utf16Index > text.length) throw new Error('Invalid native source position');
  return Buffer.byteLength(text.slice(0, utf16Index), 'utf8');
}

export function normalizeReplacement(template, oldIdentifiers, newIdentifiers) {
  if (oldIdentifiers.length !== newIdentifiers.length) throw new Error('Native identifier signatures have different lengths');
  const replacements = new Map();
  oldIdentifiers.forEach((name, index) => {
    if (replacements.has(name) && replacements.get(name) !== newIdentifiers[index]) throw new Error(`Conflicting native binding ${name}`);
    replacements.set(name, newIdentifiers[index]);
  });
  const source = ts.createSourceFile('replacement.js', template, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const spans = [];
  function visit(node) {
    if (ts.isIdentifier(node) && !semanticProperty(node)) {
      const replacement = replacements.get(node.text);
      if (replacement !== undefined) {
        const start = node.getStart(source), scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, template);
        scanner.setTextPos(start);
        if (scanner.scan() !== ts.SyntaxKind.Identifier || scanner.getTextPos() !== node.getEnd()) throw new Error('Native replacement is not an identifier token');
        spans.push({ start, end: node.getEnd(), replacement });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  let result = '', cursor = 0;
  for (const { start, end, replacement } of spans.sort((a, b) => a.start - b.start)) {
    result += template.slice(cursor, start) + replacement;
    cursor = end;
  }
  return result + template.slice(cursor);
}
