#!/usr/bin/env python3
"""Extract the verified local Claude Code UI dependency graph."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import struct
import subprocess
import sys

EXPECTED_SHA256 = "5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37"
EXPECTED_VERSION = "2.1.302"
FILE_COUNT = 2705
JS_COUNT = 2451
PREFIX = "/$bunfs/root/"
ROOTS = {
    "React": {"file": "chunk-ged0ft2g.js", "exports": ["B", "Xd"]},
    "BaseBox": {"file": "chunk-j2tk5v4s.js", "exports": ["vc"]},
    "BaseText": {"file": "chunk-174fh6cj.js", "exports": ["jc"]},
    "inputAndRenderer": {"file": "chunk-tdpa6qc1.js", "exports": ["Xre", "L6"]},
    "config": {"file": "chunk-2jyw98bz.js", "exports": ["Xht"]},
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def checked_slice(data, offset, size):
    if offset < 0 or size < 0 or offset > len(data) or size > len(data) - offset:
        raise ValueError(f"Range outside binary: offset={offset}, size={size}")
    return data[offset:offset + size]


def safe_relative(path):
    if not path.startswith(PREFIX):
        raise ValueError(f"Unexpected embedded path: {path!r}")
    relative = path[len(PREFIX):]
    parts = relative.split("/")
    if not relative or any(part in ("", ".", "..") for part in parts) or "\\" in relative or "\0" in relative:
        raise ValueError(f"Unsafe embedded path: {path!r}")
    if PurePosixPath(relative).is_absolute():
        raise ValueError(f"Absolute embedded path: {path!r}")
    return relative


def bun_segment(data):
    if checked_slice(data, 0, 4) != b"\xcf\xfa\xed\xfe":
        raise ValueError("Expected a 64-bit little-endian Mach-O binary")
    ncmds, sizeofcmds = struct.unpack_from("<II", checked_slice(data, 16, 8))
    commands_end = 32 + sizeofcmds
    checked_slice(data, 32, sizeofcmds)
    offset = 32
    found = []
    for _ in range(ncmds):
        command, size = struct.unpack_from("<II", checked_slice(data, offset, 8))
        if size < 8 or offset + size > commands_end:
            raise ValueError("Invalid Mach-O load command")
        if command == 0x19:
            if size < 72:
                raise ValueError("Truncated LC_SEGMENT_64")
            name = checked_slice(data, offset + 8, 16).rstrip(b"\0")
            if name == b"__BUN":
                fileoff, filesize = struct.unpack_from("<QQ", data, offset + 40)
                checked_slice(data, fileoff, filesize)
                found.append((fileoff, filesize))
        offset += size
    if offset != commands_end or len(found) != 1:
        raise ValueError("Expected exactly one valid __BUN segment")
    return found[0]


def parse_records(data):
    segment_offset, segment_size = bun_segment(data)
    base = segment_offset + 8
    segment_end = segment_offset + segment_size
    segment = checked_slice(data, segment_offset, segment_size)
    first = (PREFIX + "chunk-gc95262s.js").encode()
    candidates = []
    start = 0
    while True:
        hit = segment.find(first + b"\0", start)
        if hit < 0:
            break
        start = hit + 1
        pointer = struct.pack("<II", segment_offset + hit - base, len(first))
        search = 0
        while True:
            position = segment.find(pointer, search)
            if position < 0:
                break
            search = position + 1
            table = segment_offset + position
            if table + FILE_COUNT * 52 > segment_end:
                continue
            values = struct.unpack_from("<13I", data, table)
            source = base + values[2]
            if source < segment_end and data[source:source + len(b"// @bun @bytecode\n")] == b"// @bun @bytecode\n":
                candidates.append(table)
    if len(candidates) != 1:
        raise ValueError(f"Expected one metadata table; found {len(candidates)}")
    table = candidates[0]
    records = []
    names = set()
    for index in range(FILE_COUNT):
        record_offset = table + index * 52
        values = struct.unpack_from("<13I", checked_slice(data, record_offset, 52))
        path_offset, path_size, source_offset, source_size = values[:4]
        for relative, size in [(path_offset, path_size + 1), (source_offset, source_size)]:
            if base + relative < segment_offset or base + relative + size > segment_end:
                raise ValueError(f"Record {index}: range outside __BUN")
        path_bytes = checked_slice(data, base + path_offset, path_size + 1)
        if not path_bytes.endswith(b"\0"):
            raise ValueError(f"Record {index}: unterminated path")
        path = path_bytes[:-1].decode("utf-8", errors="strict")
        name = safe_relative(path)
        if name in names:
            raise ValueError(f"Duplicate embedded path: {path}")
        names.add(name)
        source = checked_slice(data, base + source_offset, source_size)
        is_js = index < JS_COUNT
        if is_js and (values[12] != 65793 or not source.startswith(b"// @bun @bytecode\n")):
            raise ValueError(f"Record {index}: invalid JavaScript metadata")
        records.append({"path": path, "relative_path": name, "metadata_offset": record_offset,
                        "source_offset": base + source_offset, "source_size": source_size,
                        "source_sha256": sha256(source), "flags": values[12], "javascript": is_js})
    return {"offset": segment_offset, "size": segment_size, "base": base, "table_offset": table}, records


def dependency_graph(data, records, binary):
    sources = {r["relative_path"]: checked_slice(data, r["source_offset"], r["source_size"]).decode("utf-8")
               for r in records if r["javascript"]}
    helper = Path(__file__).with_name("imports.mjs")
    environment = {**os.environ, "BUN_OPTIONS": f"--preload={helper.resolve()}"}
    process = subprocess.run([str(binary.resolve())], env=environment,
                             input=json.dumps(sources), text=True, capture_output=True)
    if process.returncode:
        raise ValueError(f"JavaScript import analysis failed: {process.stderr.strip()}")
    return json.loads(process.stdout)


def select_dependencies(records, graph):
    by_name = {r["relative_path"]: r for r in records}
    selected = set()
    pending = [root["file"] for root in ROOTS.values()]
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        if name not in by_name:
            raise ValueError(f"Missing internal dependency: {name}")
        selected.add(name)
        references = graph.get(name, {"internal": [], "external": []})
        for dependency in references["internal"]:
            pending.append(safe_relative(dependency))
        for dependency in references["external"]:
            if dependency["resolved"] is None:
                raise ValueError(f"Missing external module {dependency['specifier']!r} referenced by {name}")
    return selected


def rewrite(source, output):
    # Remove Bun's bytecode directive so the extracted source is compiled normally.
    if source.startswith(b"// @bun @bytecode\n"):
        source = b"// Extracted from local Claude Code\n" + source[len(b"// @bun @bytecode\n"):]
        source = source.replace(PREFIX.encode(), (str(output) + "/").encode())
    return source


def write_files(binary, output, dry_run=False):
    data = binary.read_bytes()
    digest = sha256(data)
    if digest != EXPECTED_SHA256:
        raise ValueError(f"Unsupported binary SHA-256: {digest}; expected {EXPECTED_SHA256}")
    segment, records = parse_records(data)
    graph = dependency_graph(data, records, binary)
    selected = select_dependencies(records, graph)
    output = output.resolve()
    generated = {}
    for record in records:
        name = record["relative_path"]
        record["selected"] = name in selected
        if name not in selected:
            continue
        content = rewrite(checked_slice(data, record["source_offset"], record["source_size"]), output)
        record["derived_sha256"] = sha256(content)
        record["dependencies"] = graph.get(name, {"internal": [], "external": []})
        generated[name] = content
    manifest = {"schema_version": 1, "generator": "scripts/extract.py", "version": EXPECTED_VERSION,
                "binary": str(binary.resolve()), "binary_sha256": digest, "segment": segment,
                "entry_points": ROOTS, "selected_count": len(selected), "files": records}
    old_manifest = output / "manifest.json"
    if old_manifest.is_symlink():
        raise ValueError(f"Refusing to overwrite a symlink manifest: {old_manifest}")
    old = json.loads(old_manifest.read_text()) if old_manifest.exists() else None
    if old is not None and (old.get("schema_version") != 1 or old.get("generator") != "scripts/extract.py"
                            or old.get("binary_sha256") != EXPECTED_SHA256):
        raise ValueError("Refusing to overwrite an unrecognized manifest")
    old_files = {r["relative_path"]: r for r in old["files"] if r.get("selected")} if old else {}
    for name, content in generated.items():
        target = output / name
        if target.is_symlink() or any(parent.is_symlink() for parent in target.parents if parent != output.parent):
            raise ValueError(f"Refusing to write through a symlink: {target}")
        if target.exists() and target.read_bytes() != content:
            prior = old_files.get(name)
            if prior is None or sha256(target.read_bytes()) != prior.get("derived_sha256"):
                raise ValueError(f"Refusing to overwrite an unrecognized or edited file: {target}")
    if not dry_run:
        output.mkdir(parents=True, exist_ok=True)
        for name, content in generated.items():
            target = output / name
            if target.exists() and target.read_bytes() == content:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        old_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=Path.home() / ".local/share/claude/versions/2.1.302")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "vendor/claude")
    parser.add_argument("--dry-run", action="store_true", help="Validate without writing files")
    args = parser.parse_args()
    try:
        manifest = write_files(args.binary, args.output, args.dry_run)
    except (ValueError, OSError, KeyError, UnicodeError, json.JSONDecodeError) as error:
        parser.exit(1, f"Extraction failed: {error}\n")
    print(f"Validated {len(manifest['files'])} files; selected {manifest['selected_count']} UI dependencies")


if __name__ == "__main__":
    main()
