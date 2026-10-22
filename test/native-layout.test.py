import importlib.util
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location("native_layout", Path(__file__).resolve().parents[1] / "scripts/native-layout.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)


def fixture(names=("chunk-renamed.js", "asset.txt")):
    data = bytearray(112)
    data[:4] = b"\xcf\xfa\xed\xfe"
    struct.pack_into("<II", data, 16, 1, 72)
    struct.pack_into("<II16s", data, 32, 0x19, 72, b"__BUN")
    base, values = 112, []
    for name in names:
        source = layout.JS_HEADER + b"// Version: 2.1.999\nexport {};" if name.endswith(".js") else b"resource"
        values.append([0, 0, len(data) - base, len(source), 0, 0, 0, 0, 0, 0, 0, 0, 65793 if name.endswith(".js") else 16778496])
        data.extend(source + b"\0")
    for name, fields in zip(names, values):
        path = layout.PREFIX + name.encode()
        fields[0:2] = [len(data) - base, len(path)]
        data.extend(path + b"\0")
    table = len(data)
    for fields in values:
        data.extend(struct.pack("<13I", *fields))
    data.extend(b"\0" * 128)
    struct.pack_into("<QQ", data, 72, 104, len(data) - 104)
    return data, table, values


class NativeLayoutTests(unittest.TestCase):
    def test_renamed_chunks_and_variable_count(self):
        for names in (("chunk-a.js",), ("first.dat", "chunk-new.js", "last.dat")):
            data, table, _ = fixture(names)
            segment, records = layout.parse_records(data)
            self.assertEqual(segment["table_offset"], table)
            self.assertEqual([r["relative_path"] for r in records], list(names))
            self.assertEqual(layout.binary_version(data, records), "2.1.999")

    def test_source_range_outside_segment(self):
        data, table, _ = fixture()
        struct.pack_into("<I", data, table + 52 + 8, len(data))
        with self.assertRaisesRegex(ValueError, "range outside"):
            layout.parse_records(data)

    def test_bytecode_range_outside_segment(self):
        data, table, _ = fixture()
        struct.pack_into("<II", data, table + 24, len(data), 8)
        with self.assertRaisesRegex(ValueError, "range outside"):
            layout.parse_records(data)

    def test_duplicate_path(self):
        data, _, _ = fixture(("chunk-a.js", "chunk-a.js"))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            layout.parse_records(data)

    def test_unknown_asset_flags(self):
        data, table, _ = fixture()
        struct.pack_into("<I", data, table + 52 + 48, 0xDEADBEEF)
        with self.assertRaisesRegex(ValueError, "flags"):
            layout.parse_records(data)

    def test_damaged_first_record_is_not_skipped(self):
        data, table, _ = fixture(("first.dat", "chunk-a.js"))
        struct.pack_into("<I", data, table, len(data))
        with self.assertRaisesRegex(ValueError, "boundaries"):
            layout.parse_records(data)

    def test_damaged_last_record_is_not_skipped(self):
        data, table, _ = fixture()
        struct.pack_into("<I", data, table + 52, len(data))
        with self.assertRaisesRegex(ValueError, "boundaries"):
            layout.parse_records(data)

    def test_unterminated_source(self):
        data, _, values = fixture()
        data[112 + values[1][2] + values[1][3]] = 1
        with self.assertRaisesRegex(ValueError, "Unterminated"):
            layout.parse_records(data)

    def test_unterminated_path(self):
        data, _, values = fixture()
        data[112 + values[1][0] + values[1][1]] = 1
        with self.assertRaisesRegex(ValueError, "boundaries"):
            layout.parse_records(data)

    def test_javascript_header_and_flags_must_agree(self):
        data, table, _ = fixture(("chunk-a.js", "chunk-b.js"))
        struct.pack_into("<I", data, table + 48, 16778496)
        with self.assertRaisesRegex(ValueError, "JavaScript metadata"):
            layout.parse_records(data)

    def test_unsafe_path(self):
        data, _, _ = fixture(("chunk-a.js", "../private"))
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            layout.parse_records(data)

    def test_segment_outside_binary(self):
        data, _, _ = fixture()
        struct.pack_into("<Q", data, 80, len(data))
        with self.assertRaisesRegex(ValueError, "segment bounds"):
            layout.parse_records(data)

    def test_truncated_load_command(self):
        data, _, _ = fixture()
        struct.pack_into("<I", data, 36, 8)
        with self.assertRaisesRegex(ValueError, "Truncated LC_SEGMENT"):
            layout.parse_records(data)

    def test_ambiguous_table(self):
        data, table, _ = fixture()
        data.extend(data[table:table + 104])
        struct.pack_into("<Q", data, 80, len(data) - 104)
        with self.assertRaisesRegex(ValueError, "found 2"):
            layout.parse_records(data)

    def test_conflicting_versions(self):
        data, _, _ = fixture(("chunk-a.js", "chunk-b.js"))
        _, records = layout.parse_records(data)
        start = records[1]["source_offset"]
        at = data.index(b"2.1.999", start)
        data[at:at + 7] = b"2.1.998"
        with self.assertRaisesRegex(ValueError, "found 2"):
            layout.binary_version(data, records)

    def test_missing_version(self):
        data, _, _ = fixture()
        _, records = layout.parse_records(data)
        at = data.index(b"// Version:")
        data[at:at + 2] = b"/*"
        with self.assertRaisesRegex(ValueError, "found 0"):
            layout.binary_version(data, records)

    def test_real_308_binary(self):
        binary = Path.home() / ".local/share/claude/versions/2.1.308"
        if not binary.is_file():
            self.skipTest("Local Claude Code 2.1.308 fixture unavailable")
        data = binary.read_bytes()
        segment, records = layout.parse_records(data)
        self.assertEqual(layout.binary_version(data, records), "2.1.308")
        self.assertGreater(len(records), 2705)
        self.assertEqual(records[-1]["metadata_offset"], segment["table_offset"] + (len(records) - 1) * 52)
        self.assertTrue(any(r["javascript"] for r in records))
        self.assertTrue(any(not r["javascript"] for r in records))


if __name__ == "__main__":
    unittest.main()
