import importlib.util
import os
from pathlib import Path
import struct
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location('build_native', ROOT / 'scripts/build-native.py')
native = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(native)


class NativeBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = Path(os.environ['CLAUDE_NATIVE_BINARY']).resolve() if os.environ.get('CLAUDE_NATIVE_BINARY') else native.discover_binary()
        cls.original = cls.binary.read_bytes()
        cls.segment, cls.records = native.layout.parse_records(cls.original)
        cls.expected, cls.changed, cls.preserved, cls.details = native.patch_plan(cls.binary)

    def test_only_connection_modules_change_and_cli_bytecode_is_preserved(self):
        changed = set(self.changed)
        self.assertTrue(changed)
        self.assertEqual(len(changed), len(self.changed))
        self.assertEqual(self.preserved, sum(r['javascript'] for r in self.records) - len(changed))
        self.assertEqual(self.details['version'], native.layout.binary_version(self.original, self.records))
        self.assertEqual(self.details['binary_sha256'], native.sha256(self.original))
        self.assertTrue(self.details['symbols'])
        self.assertNotIn('cli', changed)
        for record in self.records:
            with self.subTest(module=record['relative_path']):
                offset = record['metadata_offset']
                before = struct.unpack_from('<13I', self.original, offset)
                after = struct.unpack_from('<13I', self.expected, offset)
                if record['relative_path'] in changed:
                    self.assertEqual(after[6:8], (0, 0))
                    source = native.checked_slice(self.original, record['source_offset'], record['source_size'])
                    derived = self.expected[self.segment['base'] + after[2]:self.segment['base'] + after[2] + after[3]]
                    self.assertNotEqual(source, derived)
                    self.assertTrue(derived.startswith(b'// Extracted from local Claude Code\n'))
                    self.assertFalse(derived.startswith(native.layout.JS_HEADER))
                    self.assertEqual(before[:2] + before[4:6] + before[8:], after[:2] + after[4:6] + after[8:])
                else:
                    self.assertEqual(before, after)
                    for start, size in [(before[2], before[3]), (before[6], before[7])]:
                        start += self.segment['base']
                        self.assertEqual(memoryview(self.original)[start:start + size], memoryview(self.expected)[start:start + size])

    def test_module_bindings_and_import_export_declarations_are_unchanged(self):
        sources = []
        for record in self.records:
            if record['relative_path'] in self.changed:
                source = native.checked_slice(self.original, record['source_offset'], record['source_size'])
                values = struct.unpack_from('<13I', self.expected, record['metadata_offset'])
                derived = self.expected[self.segment['base'] + values[2]:self.segment['base'] + values[2] + values[3]]
                sources.append([record['relative_path'], source.decode(), derived.decode()])
        script = r"""
const ts=require('./node_modules/typescript');
const {rows,symbols}=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
const privateBindings=Object.values(symbols).flatMap(Object.values).filter(b=>b.private);
const expected=new Map(privateBindings.map(b=>[`${b.module}:${b.export}`,b]));
const seen=new Set();
function registration(statement){
 if(!ts.isExpressionStatement(statement)||!ts.isCallExpression(statement.expression))return null;
 const call=statement.expression, setter=call.expression;
 if(!ts.isPropertyAccessExpression(setter)||setter.name.text!=='set')return null;
 const originals=setter.expression;
 if(!ts.isPropertyAccessExpression(originals)||originals.name.text!=='originals')return null;
 const registry=originals.expression;
 if(!ts.isElementAccessExpression(registry)||!ts.isIdentifier(registry.expression)||registry.expression.text!=='globalThis')return null;
 const symbol=registry.argumentExpression;
 if(!ts.isCallExpression(symbol)||!ts.isPropertyAccessExpression(symbol.expression)||!ts.isIdentifier(symbol.expression.expression)||symbol.expression.expression.text!=='Symbol'||symbol.expression.name.text!=='for'||symbol.arguments.length!==1||!ts.isStringLiteral(symbol.arguments[0])||symbol.arguments[0].text!=='edualc.sdk')return null;
 if(call.arguments.length!==2||!ts.isStringLiteral(call.arguments[0])||!ts.isIdentifier(call.arguments[1]))return null;
 return {key:call.arguments[0].text,local:call.arguments[1].text};
}
function bindings(name,source,modified){
 const ast=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 if(ast.parseDiagnostics.length)throw new Error('Invalid JavaScript: '+name);
 const statements=ast.statements.filter(s=>{
  const entry=registration(s);
  if(!entry)return true;
  const target=expected.get(entry.key);
  if(!modified||!target||target.module!==name||target.export!==entry.local||seen.has(entry.key))throw new Error('Unexpected private registration: '+name);
  seen.add(entry.key);
  return false;
 });
 return statements.map(s=>{
  if(ts.isImportDeclaration(s)||ts.isExportDeclaration(s))return s.getText(ast);
  if(ts.isFunctionDeclaration(s))return [s.kind,s.name?.text,s.parameters.map(p=>p.getText(ast)),s.modifiers?.map(m=>m.kind),!!s.asteriskToken];
  if(ts.isVariableStatement(s))return [s.kind,s.declarationList.flags,s.declarationList.declarations.map(d=>d.name.getText(ast))];
  return [s.kind,s.name?.text];
 });
}
for(const [name,before,after]of rows){if(JSON.stringify(bindings(name,before,false))!==JSON.stringify(bindings(name,after,true)))throw new Error('Module bindings changed: '+name);}
if(seen.size!==expected.size)throw new Error('Missing private registration');
"""
        subprocess.run(['node', '-e', script], cwd=ROOT, input=json.dumps({'rows': sources, 'symbols': self.details['symbols']}), text=True, check=True)

    def test_context_uses_sdk_usage(self):
        context_modules = []
        for record in self.records:
            if record['relative_path'] not in self.changed:
                continue
            values = struct.unpack_from('<13I', self.expected, record['metadata_offset'])
            source = self.expected[self.segment['base'] + values[2]:self.segment['base'] + values[2] + values[3]]
            if b'.sdkContextUsage(' in source:
                context_modules.append(record['relative_path'])
        self.assertEqual(len(context_modules), 1)

    def test_modified_native_code_or_preserved_bytecode_is_rejected(self):
        modified = bytearray(self.expected)
        first = struct.unpack_from('<13I', self.original, self.records[0]['metadata_offset'])
        for offset in [4096, self.segment['base'] + first[6]]:
            with self.subTest(offset=offset):
                modified[offset] ^= 1
                with self.assertRaisesRegex(ValueError, 'differs'):
                    native.verify_content(self.expected, modified)
                modified[offset] ^= 1

    def test_changed_source_is_rejected(self):
        record = next(r for r in self.records if r['relative_path'] in self.changed)
        values = struct.unpack_from('<13I', self.expected, record['metadata_offset'])
        modified = bytearray(self.expected)
        modified[self.segment['base'] + values[2]] ^= 1
        with self.assertRaisesRegex(ValueError, 'differs'):
            native.verify_content(self.expected, modified)

    def test_source_overflow_is_rejected(self):
        bytecode_capacity = sum(struct.unpack_from('<13I', self.original, r['metadata_offset'])[7]
                                for r in self.records if r['relative_path'] in self.changed)
        layout_header = native.layout.JS_HEADER.decode()
        resolved = {'modifiedSources': {self.changed[0]: layout_header + 'x' * (bytecode_capacity + 1)},
                    'symbols': self.details['symbols']}
        with patch.object(native, 'resolve_sources', return_value=resolved):
            with self.assertRaisesRegex(ValueError, 'exceed'):
                native.patch_plan(self.binary)

    def test_invalid_original_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / 'binary'
            binary.write_bytes(b'not a Mach-O binary')
            with self.assertRaisesRegex(ValueError, 'Mach-O'):
                native.patch_plan(binary)


if __name__ == '__main__':
    unittest.main()
