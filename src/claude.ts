import { readFileSync } from 'node:fs';

type Binding = { module: string; export: string; private?: boolean };
type Symbols = Record<string, Record<string, Binding>>;
const claudeRoot = new URL('file:///$bunfs/root/');
const modules = new Map<string, Promise<Record<string, any>>>();
let symbols: Symbols | undefined;

function nativeSymbols(): Symbols {
  if (symbols) return symbols;
  const manifest = JSON.parse(readFileSync(new URL('../native/manifest.json', import.meta.url), 'utf8'));
  if (!manifest.symbols || typeof manifest.symbols !== 'object' || Array.isArray(manifest.symbols)) {
    throw new Error('The native manifest has no Claude Code symbol bindings');
  }
  symbols = manifest.symbols as Symbols;
  return symbols;
}

export function loadNativeModule(baselineFile: string): Promise<Record<string, any>> {
  const cached = modules.get(baselineFile);
  if (cached) return cached;
  const loading = (async () => {
    const bindings = nativeSymbols()[baselineFile];
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
      throw new Error(`The native manifest has no module binding for ${baselineFile}`);
    }
    const entries = await Promise.all(Object.entries(bindings).map(async ([name, binding]) => {
      if (!binding || !/^[a-zA-Z0-9_-]+\.js$/.test(binding.module) || typeof binding.export !== 'string') {
        throw new Error(`Invalid native symbol binding: ${baselineFile}:${name}`);
      }
      const original = await import(new URL(binding.module, claudeRoot).href);
      const value = binding.private === true
        ? (globalThis as any)[Symbol.for('edualc.sdk')]?.originals?.get(`${binding.module}:${binding.export}`)
        : Object.hasOwn(original, binding.export) ? original[binding.export] : undefined;
      if (value === undefined) {
        throw new Error(`The native symbol is unavailable: ${binding.module}:${binding.export}`);
      }
      return [name, value] as const;
    }));
    const namespace = Object.freeze(Object.fromEntries(entries));
    return new Proxy(namespace, {
      get(target, name, receiver) {
        if (name === 'then' || typeof name === 'symbol') return Reflect.get(target, name, receiver);
        if (!Object.hasOwn(target, name)) throw new Error(`The native manifest has no export binding for ${baselineFile}:${name}`);
        return Reflect.get(target, name, receiver);
      },
    });
  })();
  modules.set(baselineFile, loading);
  return loading;
}
