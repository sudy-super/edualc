import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeModule, signature } from '../scripts/native-ast.mjs';
import { resolveSymbols } from '../scripts/native-symbols.mjs';

function resolve(modules, definition, guards = [], moduleAnchors = []) {
  const directory = mkdtempSync(join(tmpdir(), 'edualc-symbols-test-'));
  const path = join(directory, 'profile.json');
  try {
    writeFileSync(path, JSON.stringify({ schema: 1, bindings: [{ module: 'baseline.js', export: 'helper',
      selectors: [{ hash: signature(definition.node).hash, guards, moduleAnchors }] }] }));
    return resolveSymbols(modules, path);
  } finally { rmSync(directory, { recursive: true }); }
}

test('native symbols follow renamed bindings and export aliases', () => {
  const baseline = analyzeModule('old.js', 'function oldName(input){return {value:input.value}}');
  const original = analyzeModule('renamed.js', 'function newName(data){return {value:data.value}} export {newName as publicName};');
  const result = resolve(new Map([[original.file, original]]), baseline.definitions.get('oldName'));
  expect(result.symbols['baseline.js'].helper).toEqual({ module: 'renamed.js', export: 'publicName' });
  expect(result.privateBindings).toEqual([]);
});

test('native symbols register the actual local binding when it is private', () => {
  const original = analyzeModule('private.js', 'function local(input){return input.amount+1}');
  const result = resolve(new Map([[original.file, original]]), original.definitions.get('local'));
  expect(result.privateBindings).toEqual([{ module: 'private.js', export: 'local', private: true }]);
});

test('native symbols reject missing and ambiguous definitions', () => {
  const first = analyzeModule('first.js', 'function one(input){return input.value}');
  const second = analyzeModule('second.js', 'function two(input){return input.value}');
  const definition = first.definitions.get('one');
  expect(() => resolve(new Map(), definition)).toThrow('found 0');
  expect(() => resolve(new Map([[first.file, first], [second.file, second]]), definition)).toThrow('found 2');
});

test('native symbol guards verify imported dependencies instead of choosing the first wrapper', () => {
  const source = analyzeModule('old.js', 'function dependency(value){return value.amount+1} function wrapper(value){return dependency(value)}');
  const target = analyzeModule('dependency.js', 'function calculate(value){return value.amount+1} export {calculate as run};');
  const correct = analyzeModule('correct.js', 'import {run as execute} from "/$bunfs/root/dependency.js"; function wrapper(value){return execute(value)}');
  const wrong = analyzeModule('wrong.js', 'function execute(value){return value.amount-1} function wrapper(value){return execute(value)}');
  const definition = source.definitions.get('wrapper');
  const guards = [{ identifier: signature(definition.node).identifiers.indexOf('dependency'), hash: signature(source.definitions.get('dependency').node).hash }];
  const result = resolve(new Map([[wrong.file, wrong], [correct.file, correct], [target.file, target]]), definition, guards);
  expect(result.symbols['baseline.js'].helper.module).toBe('correct.js');
  expect(() => resolve(new Map([[wrong.file, wrong]]), definition, guards)).toThrow('found 0');
});


test('native symbols distinguish identical helpers by verified neighboring functions', () => {
  const correct = analyzeModule('correct.js', 'function helper(){return 1} function authentication(token){return token.accessToken}');
  const wrong = analyzeModule('wrong.js', 'function helper(){return 1} function authentication(token){return token.apiKey}');
  const definition = correct.definitions.get('helper');
  const moduleAnchors = [signature(correct.definitions.get('authentication').node).hash];
  const result = resolve(new Map([[wrong.file, wrong], [correct.file, correct]]), definition, [], moduleAnchors);
  expect(result.symbols['baseline.js'].helper.module).toBe('correct.js');
  expect(() => resolve(new Map([[wrong.file, wrong]]), definition, [], moduleAnchors)).toThrow('found 0');
});
