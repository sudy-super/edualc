#!/usr/bin/env python3
"""Extract the original Claude Code CLI and its complete dependency graph."""
import argparse
import json
from pathlib import Path

import extract as common

GENERATOR = "scripts/extract-full.py"
SDK_ADAPTER = Path(__file__).resolve().parents[1] / "src/sdk-run.ts"
ENGINE_GLUE = "chunk-bhpwzt8n.js"
ADAPTER_ROOT = SDK_ADAPTER.parent
EXPORT_BRIDGES = {
    "chunk-v79yvp1y.js": ('export{Hns,Dns,Lns,HAn,J_e};',
                           'export{Hns,Dns,Lns,HAn};', 'sdk-auxiliary.ts', 'sdkGenerateTitle as J_e'),
    "chunk-6mb4af0f.js": ('export{btr,sEt};', 'export{btr};',
                          'sdk-auxiliary.ts', 'sdkSideQuestion as sEt'),
    "chunk-m7gqkrhq.js": ('export{se as call,v as compactManually};',
                          'export{A as compactDisplayText};', 'sdk-compact.ts',
                          'sdkCompactCall as call,sdkCompactManually as compactManually'),
}
FORK_BRIDGES = {"chunk-emqg0p7z.js", "chunk-b6hzxg02.js", "chunk-swjk3jdr.js", "chunk-1svntv7y.js"}
COMPLETION_BRIDGE = "chunk-hqtnbrjd.js"
COMPACT_HISTORY_BRIDGE = "chunk-e759yekb.js"


def replace_once(content, before, after):
    if content.count(before) != 1:
        raise ValueError(f"Expected exactly one connection boundary: {before[:100]!r}")
    return content.replace(before, after, 1)


def bridge_changes(name):
    return name in {ENGINE_GLUE, COMPLETION_BRIDGE, COMPACT_HISTORY_BRIDGE} or name in EXPORT_BRIDGES or name in FORK_BRIDGES


def select_cli_dependencies(records, graph):
    known = {record["relative_path"] for record in records}
    selected = set()
    pending = ["cli"]
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        if name not in known:
            raise ValueError(f"Missing embedded dependency: {name}")
        selected.add(name)
        dependencies = graph.get(name, {"internal": [], "external": []})
        pending.extend(common.safe_relative(path) for path in dependencies["internal"])
        for external in dependencies["external"]:
            if external["resolved"] is None:
                raise ValueError(f"Missing external module {external['specifier']!r} referenced by {name}")
    return selected


def derive_content(source, name, output, original_engine=False):
    content = common.rewrite(source, output)
    if name == "cli":
        ending = b"Ht();\n"
        if not content.endswith(ending) or content.endswith(b"await " + ending):
            raise ValueError("The verified CLI does not have the expected Ht() entry call")
        content = content[:-len(ending)] + b"await Ht();\n"
    if name == ENGINE_GLUE and not original_engine:
        original = f'import{{RD}}from"{output}/chunk-207g0kar.js";'.encode()
        replacement = f'import{{sdkRun as RD}}from"{SDK_ADAPTER}";'.encode()
        content = replace_once(content, original, replacement)
    if not original_engine and name in EXPORT_BRIDGES:
        before, retained, adapter, exports = EXPORT_BRIDGES[name]
        after = f'{retained}export{{{exports}}}from"{ADAPTER_ROOT / adapter}";'
        content = replace_once(content, before.encode(), after.encode())
    if not original_engine and name in FORK_BRIDGES:
        import re
        pattern = rb'import\{([^}]+)\}from"' + re.escape(str(output).encode()) + rb'/chunk-hqtnbrjd.js";'
        matches = list(re.finditer(pattern, content))
        if len(matches) != 1 or b"UA" not in matches[0].group(1).split(b","):
            raise ValueError(f"Expected one UA import in {name}")
        match = matches[0]
        names = b",".join(item for item in match.group(1).split(b",") if item != b"UA")
        after = b'import{' + names + f'}}from"{output}/chunk-hqtnbrjd.js";import{{sdkToolFreeFork as UA}}from"{ADAPTER_ROOT / "sdk-fork.ts"}";'.encode()
        content = content[:match.start()] + after + content[match.end():]
    if not original_engine and name == COMPLETION_BRIDGE:
        content = replace_once(content, b'async function nL(e){',
                               f'import{{sdkComplete as nL}}from"{ADAPTER_ROOT / "sdk-completion.ts"}";async function original_nL(e){{'.encode())
    if not original_engine and name == COMPACT_HISTORY_BRIDGE:
        content = replace_once(content, b'return rIt(Q),{messages:Q,shouldQuery:!1,command:r}',
                               b'return rIt(Q),alignSdkHistory(o.session.id,Q),{messages:Q,shouldQuery:!1,command:r}')
        content += f'\nimport{{alignSdkHistory}}from"{SDK_ADAPTER}";\n'.encode()
    return content


def extract_full(binary, output, dry_run=False, original_engine=False):
    data = binary.read_bytes()
    digest = common.sha256(data)
    if digest != common.EXPECTED_SHA256:
        raise ValueError(f"Unsupported binary SHA-256: {digest}")
    segment, records = common.parse_records(data)
    graph = common.dependency_graph(data, records, binary)
    selected = select_cli_dependencies(records, graph)
    output = output.resolve()
    if any(character in str(output) for character in ['"', "'", "\\", "\n", "\r"]):
        raise ValueError("The output path cannot contain quotes, backslashes, or line breaks")
    if not original_engine and not SDK_ADAPTER.is_file():
        raise ValueError(f"The mandatory SDK adapter is missing: {SDK_ADAPTER}")
    generated = {}
    for record in records:
        name = record["relative_path"]
        record["selected"] = name in selected
        if name not in selected:
            continue
        source = common.checked_slice(data, record["source_offset"], record["source_size"])
        content = derive_content(source, name, output, original_engine)
        record["derived_sha256"] = common.sha256(content)
        record["derived_size"] = len(content)
        record["dependencies"] = graph.get(name, {"internal": [], "external": []})
        generated[name] = content
    transformations = ["Remove the Bun bytecode directive", "Rewrite embedded absolute paths",
                       "Await the existing CLI Ht() call"]
    if not original_engine:
        transformations.append({"file": ENGINE_GLUE, "operation": "Replace exactly one RD import",
                                "from": f'import{{RD}}from"{output}/chunk-207g0kar.js";',
                                "to": f'import{{sdkRun as RD}}from"{SDK_ADAPTER}";'})
        transformations.extend({"file": name, "operation": "Connect existing backend boundary to SDK"}
                               for name in sorted(set(EXPORT_BRIDGES) | FORK_BRIDGES | {COMPLETION_BRIDGE, COMPACT_HISTORY_BRIDGE}))
    manifest = {"schema_version": 1, "generator": GENERATOR, "version": common.EXPECTED_VERSION,
                "binary": str(binary.resolve()), "binary_sha256": digest, "segment": segment,
                "entry_points": {"cli": {"file": "cli"}}, "selected_count": len(selected),
                "engine": "original" if original_engine else "sdk",
                "sdk_adapter": None if original_engine else str(SDK_ADAPTER),
                "transformations": transformations, "files": records}
    manifest_path = output / "manifest.json"
    if manifest_path.is_symlink():
        raise ValueError("Refusing to overwrite a symlink manifest")
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    if previous is not None and (previous.get("generator") != GENERATOR or previous.get("schema_version") != 1
                                 or previous.get("binary_sha256") != digest):
        raise ValueError("Refusing to overwrite an unrecognized manifest")
    old_files = {r["relative_path"]: r for r in previous["files"] if r.get("selected")} if previous else {}
    for name, content in generated.items():
        target = output / name
        if target.is_symlink() or any(parent.is_symlink() for parent in target.parents):
            raise ValueError(f"Refusing to write through a symlink: {target}")
        if target.exists() and target.read_bytes() != content:
            old = old_files.get(name)
            if old is None or common.sha256(target.read_bytes()) != old.get("derived_sha256"):
                raise ValueError(f"Refusing to overwrite an unrecognized or edited file: {target}")
    if not dry_run:
        output.mkdir(parents=True, exist_ok=True)
        for name, content in generated.items():
            target = output / name
            if target.exists() and target.read_bytes() == content:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=Path.home() / ".local/share/claude/versions/2.1.302")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "vendor/claude-full")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--original-engine", action="store_true", help="Keep the original engine for comparison")
    args = parser.parse_args()
    try:
        manifest = extract_full(args.binary, args.output, args.dry_run, args.original_engine)
    except (ValueError, OSError, KeyError, UnicodeError) as error:
        parser.exit(1, f"Full extraction failed: {error}\n")
    print(f"Validated {len(manifest['files'])} files; selected {manifest['selected_count']} original CLI dependencies")


if __name__ == "__main__":
    main()
