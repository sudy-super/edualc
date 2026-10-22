import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { signature } from './native-ast.mjs';

function originalDefinition(modules, module, name, visited = new Set()) {
  const key = `${module.file}:${name}`;
  if (visited.has(key)) throw new Error(`Circular native symbol binding: ${key}`);
  visited.add(key);
  const definition = module.definitions.get(name);
  if (definition) return { module, definition };
  const imported = module.imports.get(name);
  const target = imported && modules.get(basename(imported.module));
  if (!target || !target.exports.has(imported.export)) {
    throw new Error(`Cannot resolve native dependency: ${key}`);
  }
  return originalDefinition(modules, target, target.exports.get(imported.export), visited);
}

export function resolveSymbols(modules, profilePath = new URL('../profiles/symbols.json', import.meta.url)) {
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  if (profile.schema !== 1 || !Array.isArray(profile.bindings) || !profile.bindings.length) {
    throw new Error('Invalid native symbol profile');
  }
  const fingerprints = new WeakMap();
  const fingerprint = definition => {
    let value = fingerprints.get(definition);
    if (!value) { value = signature(definition.node); fingerprints.set(definition, value); }
    return value;
  };
  const index = new Map(), moduleAnchors = new Map();
  const anchorHashes = new Set(profile.bindings.flatMap(binding => binding.selectors.flatMap(selector => selector.moduleAnchors ?? [])));
  const requiredHashes = new Set(profile.bindings.flatMap(binding => binding.selectors.map(selector => selector.hash)));
  for (const module of modules.values()) for (const definition of module.definitions.values()) {
    const hash = fingerprint(definition).hash;
    if (anchorHashes.has(hash)) {
      const anchors = moduleAnchors.get(module.file) ?? new Set();
      anchors.add(hash);
      moduleAnchors.set(module.file, anchors);
    }
    if (!requiredHashes.has(hash)) continue;
    const entries = index.get(hash) ?? [];
    entries.push({ module, definition });
    index.set(hash, entries);
  }
  const symbols = {}, privateBindings = [];
  for (const binding of profile.bindings) {
    if (symbols[binding.module]?.[binding.export]) throw new Error(`Duplicate native symbol profile: ${binding.module}:${binding.export}`);
    const matches = new Map();
    for (const selector of binding.selectors) for (const candidate of index.get(selector.hash) ?? []) {
      if (!(selector.moduleAnchors ?? []).every(hash => moduleAnchors.get(candidate.module.file)?.has(hash))) continue;
      const identifiers = fingerprint(candidate.definition).identifiers;
      const valid = (selector.guards ?? []).every(guard => {
        const name = identifiers[guard.identifier];
        if (name === undefined) throw new Error(`Invalid native dependency guard: ${binding.module}:${binding.export}`);
        try {
          const dependency = originalDefinition(modules, candidate.module, name);
          return fingerprint(dependency.definition).hash === guard.hash;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Cannot resolve native dependency:')) return false;
          throw error;
        }
      });
      if (valid) matches.set(`${candidate.module.file}:${candidate.definition.name}`, candidate);
    }
    if (matches.size !== 1) {
      throw new Error(`Expected one native symbol for ${binding.module}:${binding.export}; found ${matches.size}`);
    }
    const { module, definition } = matches.values().next().value;
    const exported = [...module.exports].filter(([, local]) => local === definition.name).map(([name]) => name);
    const target = { module: module.file, export: exported[0] ?? definition.name };
    if (!exported.length) {
      target.private = true;
      if (!privateBindings.some(item => item.module === target.module && item.export === target.export)) privateBindings.push({ ...target });
    }
    (symbols[binding.module] ??= {})[binding.export] = target;
  }
  return { symbols, privateBindings };
}
