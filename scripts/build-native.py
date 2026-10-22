#!/usr/bin/env python3
"""Keep Claude Code's embedded bytecode and replace only SDK connection modules."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile

LAYOUT_SPEC = importlib.util.spec_from_file_location("native_layout", Path(__file__).with_name("native-layout.py"))
layout = importlib.util.module_from_spec(LAYOUT_SPEC)
LAYOUT_SPEC.loader.exec_module(layout)


def discover_binary():
    command = shutil.which("claude")
    if not command:
        raise ValueError("Claude Codeのネイティブ版をインストールしてください。")
    return Path(command).resolve()


def resolve_sources(sources):
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(["node", "--max-old-space-size=6144", str(root / "scripts/resolve-native.mjs")],
                            input=json.dumps({"sources": sources}), text=True,
                            capture_output=True, check=True, cwd=root)
    resolved = json.loads(result.stdout)
    changed = resolved.get("modifiedSources")
    if not isinstance(changed, dict) or not changed or not isinstance(resolved.get("symbols"), dict):
        raise ValueError("Native connection resolver returned an invalid result")
    if any(name not in sources or not isinstance(text, str) or text == sources[name] for name, text in changed.items()):
        raise ValueError("Native connection resolver returned an unknown or unchanged module")
    return resolved


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def checked_slice(data, offset, size):
    if offset < 0 or size < 0 or offset > len(data) or size > len(data) - offset:
        raise ValueError("Range outside binary")
    return data[offset:offset + size]


def signing_region(data):
    offset = 32
    found = []
    for _ in range(struct.unpack_from("<I", data, 16)[0]):
        command, size = struct.unpack_from("<II", data, offset)
        if command == 0x1D:
            found.append((offset, *struct.unpack_from("<II", data, offset + 8)))
        offset += size
    if len(found) != 1:
        raise ValueError("Expected exactly one Mach-O code signature")
    command, start, size = found[0]
    checked_slice(data, start, size)
    if start + size != len(data):
        raise ValueError("Unexpected data after the Mach-O code signature")
    return command, start


def patch_plan(binary):
    data = bytearray(binary.read_bytes())
    segment, records = layout.parse_records(data)
    version = layout.binary_version(data, records)
    if tuple(map(int, version.split("."))) < (2, 1, 302):
        raise ValueError(f"Claude Code {version} is older than 2.1.302")
    sources = {record["relative_path"]: checked_slice(data, record["source_offset"], record["source_size"]).decode("utf-8")
               for record in records if record["javascript"]}
    resolved = resolve_sources(sources)
    changed = [record for record in records if record["relative_path"] in resolved["modifiedSources"]]
    # Reuse a replaced module's bytecode region; every untouched module stays byte-for-byte intact.
    owner = max(changed, key=lambda record: struct.unpack_from("<13I", data, record["metadata_offset"])[7])
    values = struct.unpack_from("<13I", data, owner["metadata_offset"])
    cursor, limit = values[6], values[6] + values[7]
    for record in changed:
        text = resolved["modifiedSources"][record["relative_path"]]
        if not text.startswith("// @bun @bytecode\n"):
            raise ValueError("Resolved source lost its original bytecode directive")
        content = ("// Extracted from local Claude Code\n" + text[len("// @bun @bytecode\n"):]).encode("utf-8")
        if cursor + len(content) + 1 > limit:
            raise ValueError("SDK connection sources exceed the available bytecode region")
        start = segment["base"] + cursor
        data[start:start + len(content) + 1] = content + b"\0"
        metadata = list(struct.unpack_from("<13I", data, record["metadata_offset"]))
        metadata[2:4] = [cursor, len(content)]
        metadata[6:8] = [0, 0]
        struct.pack_into("<13I", data, record["metadata_offset"], *metadata)
        cursor += len(content) + 1
    details = {"version": version, "binary_sha256": sha256(binary.read_bytes()), "symbols": resolved["symbols"]}
    return data, sorted(record["relative_path"] for record in changed), len(sources) - len(changed), details


def verify_content(expected, actual):
    command, start = signing_region(expected)
    actual_command, actual_start = signing_region(actual)
    if (command, start) != (actual_command, actual_start):
        raise ValueError("Native binary signing layout changed")
    exclusions = [(command + 12, command + 16)]
    offset = 32
    for _ in range(struct.unpack_from("<I", expected, 16)[0]):
        kind, size = struct.unpack_from("<II", expected, offset)
        if kind == 0x19 and expected[offset + 8:offset + 24].rstrip(b"\0") == b"__LINKEDIT":
            file_offset = struct.unpack_from("<Q", expected, offset + 40)[0]
            file_size = len(actual) - file_offset
            vm_size = (file_size + 16383) // 16384 * 16384
            if struct.unpack_from("<Q", actual, offset + 32)[0] != vm_size or struct.unpack_from("<Q", actual, offset + 48)[0] != file_size:
                raise ValueError("Native binary signature segment size is invalid")
            exclusions.extend([(offset + 32, offset + 40), (offset + 48, offset + 56)])
        offset += size
    # Re-signing changes the signature and __LINKEDIT's corresponding sizes only.
    left, right = memoryview(expected), memoryview(actual)
    cursor = 0
    for begin, end in sorted(exclusions) + [(start, start)]:
        if left[cursor:begin] != right[cursor:begin]:
            raise ValueError("Native binary differs from the verified SDK connection patch")
        cursor = end


def manifest_for(binary, output, actual, changed, preserved, details):
    return {"schema_version": 2, "generator": "scripts/build-native.py",
            **details, "engine": "sdk",
            "binary": str(binary.resolve()),
            "native_binary": str(output.resolve()), "native_sha256": sha256(actual),
            "patched_files": changed, "preserved_bytecode_files": preserved,
            "sdk_adapter": str(Path(__file__).resolve().parents[1] / "src/sdk-run.ts")}


def verify_native(binary: Path, output: Path):
    if output.is_symlink() or output.parent.joinpath("manifest.json").is_symlink():
        raise ValueError("Refusing a symlink native binary or manifest")
    expected, changed, preserved, details = patch_plan(binary)
    actual = output.read_bytes()
    verify_content(expected, actual)
    manifest = manifest_for(binary, output, actual, changed, preserved, details)
    if json.loads(output.with_name("manifest.json").read_text()) != manifest:
        raise ValueError("Native binary manifest does not match the verified binary")
    subprocess.run(["codesign", "--verify", "--strict", str(output)], check=True, capture_output=True)
    return manifest


def build_native(binary: Path, output: Path):
    binary, output = binary.resolve(), output.absolute()
    if output == binary or output.is_symlink() or any(p.is_symlink() for p in output.parents):
        raise ValueError("Refusing to overwrite the original binary or write through a symlink")
    manifest_path = output.with_name("manifest.json")
    if output.exists() or manifest_path.exists():
        if manifest_path.is_symlink():
            raise ValueError("Refusing a symlink native manifest")
        previous = json.loads(manifest_path.read_text())
        if (previous.get("generator") != "scripts/build-native.py" or previous.get("engine") != "sdk"
                or previous.get("native_binary") != str(output.resolve())
                or previous.get("native_sha256") != sha256(output.read_bytes())):
            raise ValueError("Refusing to overwrite an unverified native build")
        subprocess.run(["codesign", "--verify", "--strict", str(output)], check=True, capture_output=True)
    expected, changed, preserved, details = patch_plan(binary)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".edualc-native-", dir=output.parent) as temporary:
        candidate = Path(temporary) / output.name
        candidate.write_bytes(expected)
        candidate.chmod(0o755)
        subprocess.run(["codesign", "--force", "--sign", "-", str(candidate)], check=True, capture_output=True)
        actual = candidate.read_bytes()
        verify_content(expected, actual)
        subprocess.run(["codesign", "--verify", "--strict", str(candidate)], check=True, capture_output=True)
        manifest = manifest_for(binary, output, actual, changed, preserved, details)
        candidate_manifest = Path(temporary) / "manifest.json"
        candidate_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        os.replace(candidate, output)
        os.replace(candidate_manifest, manifest_path)
    return manifest


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=root / "native/edualc")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    try:
        binary = args.binary
        if binary is None:
            binary = Path(os.environ["CLAUDE_NATIVE_BINARY"]) if os.environ.get("CLAUDE_NATIVE_BINARY") else discover_binary()
        manifest = (verify_native if args.verify else build_native)(binary, args.output)
    except (OSError, ValueError, KeyError, struct.error, subprocess.CalledProcessError) as error:
        detail = error.stderr if isinstance(error, subprocess.CalledProcessError) and error.stderr else str(error)
        parser.exit(1, f"Native build failed: {detail}\n")
    print(f"Verified {len(manifest['patched_files'])} SDK connection modules; preserved {manifest['preserved_bytecode_files']} bytecode modules")


if __name__ == "__main__":
    main()
