"""Compare every shipped slash command and load every original local handler.

This checks catalog identity and handler loading without invoking external actions.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
APP = Path(os.environ.get('EDUALC_APP_ROOT', ROOT))
ORIGINAL = Path.home() / '.local/share/claude/versions/2.1.302'
ARTIFACTS = ROOT / 'test/artifacts/command-catalog'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
CATEGORIES = {
    'settings': 'add-dir advisor autocompact brief color config effort fast focus hooks keybindings mcp memory model output-style pause-memory permissions plan plugin privacy-settings reload-plugins reload-skills sandbox scroll-speed skills theme tui vim wellbeing low-priority'.split(),
    'conversation': 'auto-mode-setup background branch btw clear compact context copy diff export fork goal help import init insights loops recap rename resume rewind security-review session statusline stop subtask tasks workflow-launch-exec workflows team-onboarding'.split(),
    'process': 'agents cd exit heapdump list-agents restart status'.split(),
    'external': '__remote-workflow artifacts autofix-pr bug chrome claim-credit cloud-plugins design-consent design-login design-revoke desktop extra-usage feedback ide install-github-app install-slack-app limit-reset login logout mobile passes powerup pro-trial-expired radio rate-limit-options release-notes remote-control remote-env schedule setup-bedrock setup-vertex stickers teleport terminal-setup ultraplan ultrareview upgrade usage usage-credits voice web-setup'.split(),
}
BY_NAME = {name: category for category, names in CATEGORIES.items() for name in names}
results = {}
with tempfile.TemporaryDirectory(prefix='edualc-command-catalog-') as temporary:
    for name, executable in [('original', ORIGINAL), ('edualc', APP / 'native/edualc')]:
        output = ARTIFACTS / f'{name}.json'
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(('ANTHROPIC_', 'CLAUDE_', 'EDUALC_', 'BUN_'))}
        environment.update(HOME=temporary, BUN_OPTIONS=f'--preload={ROOT / "scripts/verify-command-catalog.mjs"}',
                           EDUALC_COMMAND_CATALOG_FILE=str(output), DISABLE_AUTOUPDATER='1',
                           CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
        process = subprocess.run([str(executable)], env=environment, capture_output=True, text=True, timeout=30)
        assert process.returncode == 0, (name, process.stdout, process.stderr)
        results[name] = json.loads(output.read_text())

original, edualc = results['original'], results['edualc']
assert original['commandEntries'] == edualc['commandEntries'] == 133
assert original['uniqueNames'] == edualc['uniqueNames'] == 108
assert len(original['commands']) == len(edualc['commands'])
records = []
for before, after in zip(original['commands'], edualc['commands']):
    assert before['name'] == after['name'] and before['type'] == after['type']
    differences = [key for key in before.keys() | after.keys() if before.get(key) != after.get(key)]
    assert not differences or (before['name'] == 'compact' and differences == ['handlerHash']), (before['name'], differences)
    assert before['name'] in BY_NAME, f'Unclassified command: {before["name"]}'
    records.append({'name': before['name'], 'type': before['type'], 'category': BY_NAME[before['name']],
                    'handler_loaded': after.get('loaded'), 'implementation': f'SDK {before["name"]} bridge' if differences else 'original preserved',
                    'external_execution': 'excluded' if BY_NAME[before['name']] == 'external' else 'local handler/catalog comparison'})
assert {record['name'] for record in records} == set(BY_NAME), 'Stale command classification'
report = {'command_entries': len(records), 'unique_names': len({record['name'] for record in records}),
          'loaded_handlers': sum(record['handler_loaded'] is True for record in records),
          'method': 'All catalog entries, metadata and local handler source hashes compared against the original binary; every loadable handler imported. This is distinct from exercising every UI action.',
          'commands': records}
(ARTIFACTS / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({key: value for key, value in report.items() if key != 'commands'}, ensure_ascii=False, indent=2))
