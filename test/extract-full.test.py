import importlib.util
from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("extract_full", SCRIPTS / "extract-full.py")
full = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(full)

HEADER = b"// @bun @bytecode\n// (c) Anthropic PBC. All rights reserved.\n"


class FullExtractionTests(unittest.TestCase):
    def test_original_cli_entry_is_only_awaited(self):
        source = HEADER + b"async function Ht(){return 1}Ht();\n"
        result = full.derive_content(source, "cli", Path("/tmp/ui"))
        expected = source.replace(b"// @bun @bytecode\n", b"// Extracted from local Claude Code\n", 1)
        expected = expected[:-len(b"Ht();\n")] + b"await Ht();\n"
        self.assertEqual(result, expected)

    def test_cli_entry_shape_changes_are_rejected(self):
        for source in [HEADER + b"start();\n", HEADER + b"await Ht();\n"]:
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "expected Ht"):
                full.derive_content(source, "cli", Path("/tmp/ui"))

    def test_sdk_engine_changes_exactly_one_import_and_no_component_code(self):
        source = HEADER + b'import{RD}from"/$bunfs/root/chunk-207g0kar.js";function component(){return Qet({run:RD,queryParams:builder})}export{component};\n'
        output = Path("/tmp/ui")
        original = full.derive_content(source, full.ENGINE_GLUE, output, original_engine=True)
        sdk = full.derive_content(source, full.ENGINE_GLUE, output)
        before = b'import{RD}from"/tmp/ui/chunk-207g0kar.js";'
        after = f'import{{sdkRun as RD}}from"{full.SDK_ADAPTER}";'.encode()
        self.assertEqual(original.count(before), 1)
        self.assertEqual(sdk.count(after), 1)
        self.assertEqual(sdk, original.replace(before, after, 1))
        self.assertIn(b"function component(){return Qet({run:RD,queryParams:builder})}", sdk)

    def test_missing_or_duplicate_engine_import_is_rejected(self):
        original = b'import{RD}from"/$bunfs/root/chunk-207g0kar.js";'
        for body in [b"export{};", original + original]:
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, "exactly one"):
                full.derive_content(HEADER + body, full.ENGINE_GLUE, Path("/tmp/ui"))

    def test_non_glue_module_is_identical_in_both_modes(self):
        source = HEADER + b'import{RD}from"/$bunfs/root/chunk-207g0kar.js";export{RD};'
        sdk = full.derive_content(source, "some-ui-component.js", Path("/tmp/ui"))
        original = full.derive_content(source, "some-ui-component.js", Path("/tmp/ui"), original_engine=True)
        self.assertEqual(sdk, original)
        self.assertIn(b"// (c) Anthropic PBC. All rights reserved.", sdk)

    def test_backend_exports_connect_to_sdk_and_keep_original_display_functions(self):
        for name, (before, retained, adapter, exports) in full.EXPORT_BRIDGES.items():
            with self.subTest(name=name):
                source = HEADER + b'function display(){return "original";}' + before.encode()
                expected = full.derive_content(source, name, Path('/tmp/ui'), original_engine=True)
                replacement = f'{retained}export{{{exports}}}from"{full.ADAPTER_ROOT / adapter}";'.encode()
                self.assertEqual(full.derive_content(source, name, Path('/tmp/ui')), expected.replace(before.encode(), replacement))

    def test_tool_free_helpers_change_only_the_import_binding(self):
        source = HEADER + b'import{Ae,UA,Ov}from"/$bunfs/root/chunk-hqtnbrjd.js";async function helper(p){return UA(p)}'
        for name in full.FORK_BRIDGES:
            with self.subTest(name=name):
                result = full.derive_content(source, name, Path('/tmp/ui'))
                self.assertIn(b'import{Ae,Ov}from"/tmp/ui/chunk-hqtnbrjd.js";', result)
                self.assertIn(b'import{sdkToolFreeFork as UA}', result)
                self.assertTrue(result.endswith(b'async function helper(p){return UA(p)}'))

    def test_single_completion_boundary_is_replaced_for_internal_and_external_callers(self):
        source = HEADER + b'async function nL(e){return "original"}function helper(p){return nL(p)}export{nL};'
        result = full.derive_content(source, full.COMPLETION_BRIDGE, Path('/tmp/ui'))
        self.assertIn(b'import{sdkComplete as nL}', result)
        self.assertIn(b'async function original_nL(e){return "original"}', result)
        self.assertTrue(result.endswith(b'function helper(p){return nL(p)}export{nL};'))

    def test_cli_dependency_closure_detects_missing_files(self):
        records = [{"relative_path": "cli"}]
        graph = {"cli": {"internal": ["/$bunfs/root/absent.js"], "external": []}}
        with self.assertRaisesRegex(ValueError, "Missing embedded dependency"):
            full.select_cli_dependencies(records, graph)


if __name__ == "__main__":
    unittest.main()
