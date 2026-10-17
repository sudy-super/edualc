import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("extract", Path(__file__).parents[1] / "scripts/extract.py")
extract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(extract)


def sample_binary():
    data = bytearray(2048)
    struct.pack_into("<I", data, 0, 0xFEEDFACF)
    struct.pack_into("<II", data, 16, 1, 72)
    struct.pack_into("<II16sQQQQ", data, 32, 0x19, 72, b"__BUN", 0, 0, 128, 1920)
    base = 136
    path = b"/$bunfs/root/chunk-gc95262s.js"
    source = b"// @bun @bytecode\n// (c) Anthropic PBC. All rights reserved.\nexport{};"
    data[256:256 + len(path) + 1] = path + b"\0"
    data[512:512 + len(source)] = source
    struct.pack_into("<13I", data, 1024, 256 - base, len(path), 512 - base, len(source),
                     0, 0, 0, 0, 0, 0, 256 - base, len(path), 65793)
    return bytes(data)


class ExtractTests(unittest.TestCase):
    def parse(self, binary):
        with patch.object(extract, "FILE_COUNT", 1), patch.object(extract, "JS_COUNT", 1):
            return extract.parse_records(binary)

    def test_metadata_recovers_exact_source_and_path(self):
        binary = sample_binary()
        segment, records = self.parse(binary)
        self.assertEqual(segment["offset"], 128)
        self.assertEqual(segment["table_offset"], 1024)
        self.assertEqual(records[0]["relative_path"], "chunk-gc95262s.js")
        self.assertEqual(records[0]["source_offset"], 512)
        self.assertEqual(records[0]["source_sha256"], extract.sha256(binary[512:512 + records[0]["source_size"]]))

    def test_corrupt_metadata_source_range_is_rejected(self):
        binary = bytearray(sample_binary())
        struct.pack_into("<I", binary, 1024 + 12, 0xFFFFFFFF)
        with self.assertRaisesRegex(ValueError, "outside __BUN"):
            self.parse(bytes(binary))

    def test_corrupt_macho_command_is_rejected(self):
        binary = bytearray(sample_binary())
        struct.pack_into("<I", binary, 36, 4)
        with self.assertRaisesRegex(ValueError, "load command"):
            self.parse(bytes(binary))

    def test_duplicate_metadata_tables_are_rejected(self):
        binary = bytearray(sample_binary())
        binary[1100:1152] = binary[1024:1076]
        with self.assertRaisesRegex(ValueError, "found 2"):
            self.parse(bytes(binary))

    def test_path_traversal_and_absolute_paths_are_rejected(self):
        for path in ["/$bunfs/root/../outside", "/$bunfs/root//absolute", "/$bunfs/root/a/./b",
                     "/$bunfs/root/a\\b", "/other/file", "/$bunfs/root/"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                extract.safe_relative(path)

    def test_missing_internal_and_external_dependencies_are_rejected(self):
        records = [{"relative_path": "root.js"}]
        with patch.object(extract, "ROOTS", {"root": {"file": "root.js"}}):
            with self.assertRaisesRegex(ValueError, "Missing internal"):
                extract.select_dependencies(records, {"root.js": {"internal": ["/$bunfs/root/absent.js"], "external": []}})
            with self.assertRaisesRegex(ValueError, "Missing external"):
                extract.select_dependencies(records, {"root.js": {"internal": [], "external": [{"specifier": "missing", "resolved": None}]}})

    def test_closure_excludes_unrelated_modules(self):
        records = [{"relative_path": name} for name in ["root.js", "child.js", "unrelated.js"]]
        graph = {"root.js": {"internal": ["/$bunfs/root/child.js"], "external": []}}
        with patch.object(extract, "ROOTS", {"root": {"file": "root.js"}}):
            self.assertEqual(extract.select_dependencies(records, graph), {"root.js", "child.js"})

    def test_rewrite_preserves_copyright(self):
        original = b"// @bun @bytecode\n// (c) Anthropic PBC. All rights reserved.\nimport '/$bunfs/root/a.js';"
        result = extract.rewrite(original, Path("/tmp/vendor"))
        self.assertIn(b"// (c) Anthropic PBC. All rights reserved.", result)
        self.assertIn(b"'/tmp/vendor/a.js'", result)
        self.assertNotIn(b"@bytecode", result)

    def write_sample(self, binary, output, dry_run=False):
        name = "chunk-gc95262s.js"
        with patch.object(extract, "FILE_COUNT", 1), patch.object(extract, "JS_COUNT", 1), \
             patch.object(extract, "EXPECTED_SHA256", extract.sha256(binary.read_bytes())), \
             patch.object(extract, "ROOTS", {"root": {"file": name}}), \
             patch.object(extract, "dependency_graph", return_value={name: {"internal": [], "external": []}}):
            return extract.write_files(binary, output, dry_run)

    def test_generated_files_can_be_regenerated_but_edits_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            binary, output = Path(directory) / "binary", Path(directory) / "out"
            binary.write_bytes(sample_binary())
            self.write_sample(binary, output)
            self.write_sample(binary, output)
            target = output / "chunk-gc95262s.js"
            target.write_text("user edit")
            with self.assertRaisesRegex(ValueError, "Refusing to overwrite"):
                self.write_sample(binary, output)
            self.assertEqual(target.read_text(), "user edit")

    def test_unrecognized_existing_file_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            binary, output = Path(directory) / "binary", Path(directory) / "out"
            binary.write_bytes(sample_binary())
            output.mkdir()
            target = output / "chunk-gc95262s.js"
            target.write_text("unrelated file")
            with self.assertRaisesRegex(ValueError, "Refusing to overwrite"):
                self.write_sample(binary, output)
            self.assertEqual(target.read_text(), "unrelated file")

    def test_dry_run_does_not_write_output(self):
        with tempfile.TemporaryDirectory() as directory:
            binary, output = Path(directory) / "binary", Path(directory) / "out"
            binary.write_bytes(sample_binary())
            manifest = self.write_sample(binary, output, dry_run=True)
            self.assertEqual(manifest["selected_count"], 1)
            self.assertFalse(output.exists())

    def test_unverified_binary_is_rejected_before_parsing(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "binary"
            binary.write_bytes(b"unverified")
            with self.assertRaisesRegex(ValueError, "Unsupported binary SHA-256"):
                extract.write_files(binary, Path(directory) / "out")
            self.assertFalse((Path(directory) / "out").exists())


if __name__ == "__main__":
    unittest.main()
