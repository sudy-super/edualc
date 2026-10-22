import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import ts from '../node_modules/typescript/lib/typescript.js';
import { analyzeModule, signature, normalizeReplacement } from './native-ast.mjs';
import { resolveSymbols } from './native-symbols.mjs';

function exactlyOnce(text, before, after, label) {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) >= 0) throw new Error(`Expected one native connection boundary: ${label}`);
  return text.slice(0, at) + after + text.slice(at + before.length);
}

export function resolveNative(sources, profilePath = new URL('../profiles/native.json', import.meta.url)) {
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) throw new Error('Native sources must be an object');
  const modules = new Map(Object.entries(sources).map(([file, text]) => {
    if (typeof text !== 'string') throw new Error(`Invalid native source: ${file}`);
    return [file, analyzeModule(file, text)];
  }));
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  if (profile.schema !== 1 || !Array.isArray(profile.patches) || !profile.patches.length) throw new Error('Invalid native connection profile');
  const { symbols, privateBindings } = resolveSymbols(modules);
  const nodeIndexes = new Map(), edits = new Map();
  function nodes(module, selector) {
    const key = `${module.file}:${selector.topLevel}:${selector.kind}`;
    let result = nodeIndexes.get(key);
    if (!result) {
      result = [];
      if (selector.topLevel) {
        for (const definition of module.definitions.values()) if (definition.node.kind === selector.kind) result.push(definition.node);
      } else {
        function visit(node) {
          if (node.kind === selector.kind) result.push(node);
          ts.forEachChild(node, visit);
        }
        visit(module.source);
      }
      nodeIndexes.set(key, result);
    }
    return result;
  }
  for (const patch of profile.patches) {
    const matches = new Map();
    for (const selector of patch.selectors) for (const module of modules.values()) {
      if (!(selector.moduleMarkers ?? []).every(marker => module.literals.has(marker))) continue;
      for (const node of nodes(module, selector)) {
        const actual = signature(node);
        if (actual.hash !== selector.hash) continue;
        const bindingNames = [], bindingTargets = [];
        for (const binding of selector.bindings ?? []) {
          const targets = [...module.definitions.values()].filter(definition => signature(definition.node).hash === binding.hash);
          if (targets.length !== 1) throw new Error(`Expected one native dependency for ${patch.id}:${binding.name}; found ${targets.length}`);
          bindingNames.push(binding.name);
          bindingTargets.push(targets[0].name);
        }
        const transform = text => normalizeReplacement(
          normalizeReplacement(text, selector.identifiers, actual.identifiers), bindingNames, bindingTargets);
        const operations = selector.operations.map(operation => operation.mode === 'body'
          ? { mode: 'body', template: transform(operation.template) }
          : { mode: 'text', before: transform(operation.before), after: transform(operation.after) });
        const key = `${module.file}:${node.getStart(module.source)}:${node.getEnd()}`;
        const previous = matches.get(key);
        if (previous && JSON.stringify(previous.operations) !== JSON.stringify(operations)) throw new Error(`Conflicting native connection selectors: ${patch.id}`);
        matches.set(key, { module, node, operations });
      }
    }
    if (matches.size !== 1) throw new Error(`Expected one native connection for ${patch.id}; found ${matches.size}. This Claude Code structure is not supported.`);
    const { module, node, operations } = matches.values().next().value;
    const key = `${module.file}:${node.getStart(module.source)}:${node.getEnd()}`;
    const edit = edits.get(key) ?? { module, node, content: node.getText(module.source) };
    for (const operation of operations) {
      if (operation.mode === 'body') {
        if (!node.body || node.body.kind !== ts.SyntaxKind.Block) throw new Error(`Native connection has no function body: ${patch.id}`);
        const start = node.body.getStart(module.source) - node.getStart(module.source);
        const end = node.body.getEnd() - node.getStart(module.source);
        edit.content = edit.content.slice(0, start + 1) + operation.template + edit.content.slice(end - 1);
      } else edit.content = exactlyOnce(edit.content, operation.before, operation.after, patch.id);
    }
    edits.set(key, edit);
  }
  const modifiedSources = {};
  const grouped = new Map();
  for (const edit of edits.values()) {
    const entries = grouped.get(edit.module.file) ?? [];
    entries.push(edit);
    grouped.set(edit.module.file, entries);
  }
  for (const [file, entries] of grouped) {
    const module = modules.get(file);
    let content = module.text, lastStart = content.length;
    for (const edit of entries.sort((a, b) => b.node.getStart(module.source) - a.node.getStart(module.source))) {
      const start = edit.node.getStart(module.source), end = edit.node.getEnd();
      if (end > lastStart) throw new Error(`Overlapping native connection patches: ${file}`);
      content = content.slice(0, start) + edit.content + content.slice(end);
      lastStart = start;
    }
    modifiedSources[file] = content;
  }
  for (const binding of privateBindings) {
    const module = modules.get(binding.module);
    if (!module?.definitions.has(binding.export)) throw new Error(`Missing private native binding: ${binding.module}:${binding.export}`);
    const registration = `\nglobalThis[Symbol.for("edualc.sdk")].originals.set(${JSON.stringify(`${binding.module}:${binding.export}`)},${binding.export});\n`;
    modifiedSources[binding.module] = (modifiedSources[binding.module] ?? module.text) + registration;
  }
  for (const [file, text] of Object.entries(modifiedSources)) analyzeModule(file, text);
  return { modifiedSources, symbols };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(resolveNative(input.sources)));
  } catch (error) {
    process.stderr.write(`Native connection resolution failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
