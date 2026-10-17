import ts from "../node_modules/typescript/lib/typescript.js";
import { readFileSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
delete process.env.BUN_OPTIONS;
const files = JSON.parse(readFileSync(0, "utf8"));
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const require = createRequire(import.meta.url);
const result = {};
for (const [name, text] of Object.entries(files)) {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const internal = new Set(), external = new Set();
  function reference(value) {
    if (value.startsWith("/$bunfs/root/")) internal.add(value);
    else external.add(value);
  }
  function walk(node) {
    if (ts.isStringLiteralLike(node) && node.text.startsWith("/$bunfs/root/")) internal.add(node.text);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) reference(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) reference(node.arguments[0].text);
    ts.forEachChild(node, walk);
  }
  walk(source);
  result[name] = {internal: [...internal], external: [...external].map(specifier => {
    if (builtins.has(specifier) || specifier === "bun" || specifier.startsWith("bun:")) return {specifier, resolved: "runtime"};
    try { return {specifier, resolved: require.resolve(specifier)}; }
    catch { return {specifier, resolved: null}; }
  })};
}
writeFileSync(1, JSON.stringify(result));
process.exit(0);
