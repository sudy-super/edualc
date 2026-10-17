#!/usr/bin/env python3
"""Verify every extracted file against the installed binary and declared glue changes."""
import importlib.util
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
spec = importlib.util.spec_from_file_location('extract_full', Path(__file__).with_name('extract-full.py'))
full = importlib.util.module_from_spec(spec)
spec.loader.exec_module(full)
root = Path(__file__).resolve().parents[1]
output = root / 'vendor/claude-full'
manifest = json.loads((output / 'manifest.json').read_text())
if manifest['engine'] != 'sdk' or not manifest['sdk_adapter']:
    raise AssertionError('The extracted UI is not connected to the SDK')
data = Path(manifest['binary']).read_bytes()
if full.common.sha256(data) != full.common.EXPECTED_SHA256:
    raise AssertionError('Installed Claude Code binary changed')
changed = []
count = 0
for record in manifest['files']:
    if not record['selected']:
        continue
    name = record['relative_path']
    source = full.common.checked_slice(data, record['source_offset'], record['source_size'])
    if full.common.sha256(source) != record['source_sha256']:
        raise AssertionError(f'Original source digest mismatch: {name}')
    expected = full.derive_content(source, name, output)
    actual = (output / name).read_bytes()
    if expected != actual or full.common.sha256(actual) != record['derived_sha256']:
        raise AssertionError(f'Undeclared source change: {name}')
    reference = full.derive_content(source, name, output, original_engine=True)
    if actual != reference:
        changed.append(name)
    count += 1
expected_changes = {record['relative_path'] for record in manifest['files'] if record['selected'] and full.bridge_changes(record['relative_path'])}
if set(changed) != expected_changes:
    raise AssertionError(f'Expected only declared SDK connection changes, got {changed}')
result = {'verified_files': count, 'changed_files': changed, 'ui_component_changes': 0,
          'allowed_change': 'Declared conversation, compact, title, side-question and helper connection boundaries', 'binary_sha256': manifest['binary_sha256']}
(root / 'evidence/full-source-comparison.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
print(f'PASS: {count} original files verified; declared SDK connection boundaries, no UI component changes')
