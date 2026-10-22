# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Compare the original and SDK-connected model pickers in actual pseudoterminals."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from contextlib import ExitStack
from fixture_processes import stop_isolated_processes
root = Path(__file__).resolve().parents[1]
capture = root / 'scripts/capture-ui.py'
# The original CLI supports this switch; both processes use the same compiled catalog.
environment = {
    **os.environ,
    'ANTHROPIC_BASE_URL': 'http://127.0.0.1:9',
    'ANTHROPIC_API_KEY': 'sk-edualc-ui-fixture',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
    'DISABLE_NON_ESSENTIAL_MODEL_CALLS': '1',
    'CLAUDE_CODE_MODEL_CATALOG': 'off',
    'HTTP_PROXY': '', 'http_proxy': '', 'HTTPS_PROXY': '', 'https_proxy': '',
    'ALL_PROXY': '', 'all_proxy': '', 'NO_PROXY': '*', 'no_proxy': '*',
}
for key in ['BUN_OPTIONS', 'EDUALC_REQUIRE_PROXY', 'ANTHROPIC_AUTH_TOKEN',
            'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CONFIG_DIR']:
    environment.pop(key, None)
outputs = []
runtime = str(Path.home()/'.local/share/claude/versions/2.1.302')
# 失敗した画面の実験で利用者のクラッシュ判定・設定を変更しない。
with tempfile.TemporaryDirectory(prefix='edualc-ui-comparison-') as temporary, ExitStack() as cleanup:
    home = Path(temporary).resolve()
    cleanup.callback(stop_isolated_processes, home)
    work = home / 'work'
    work.mkdir()
    (home / '.claude').mkdir()
    (home / '.claude/settings.json').write_text(json.dumps({'tui': 'fullscreen', 'disableAllHooks': True, 'theme': 'dark'}))
    (home / '.claude.json').write_text(json.dumps({'hasCompletedOnboarding': True, 'theme': 'dark',
        'customApiKeyResponses': {'approved': ['sk-edualc-ui-fixture'[-20:]], 'rejected': []},
        'projects': {str(work): {'hasTrustDialogAccepted': True}}}))
    environment.update({'HOME': str(home),
        'CLAUDE_SECURESTORAGE_CONFIG_DIR': str(home / '.edualc'),
        'EDUALC_SDK_PACKAGE': str((root / 'node_modules/@anthropic-ai/claude-agent-sdk').resolve())})
    initial_config = (home / '.claude.json').read_bytes()
    for name, command in [('original', [runtime]), ('sdk', [str(root / 'native/edualc')])]:
        (home / '.claude.json').write_bytes(initial_config)
        capture_environment = {**environment, **({'BUN_OPTIONS': f'--preload={root / "bootstrap.mjs"}'} if name == 'sdk' else {})}
        output = root / f'test/artifacts/verified-{name}-model'
        subprocess.run([sys.executable, str(capture), '--output', str(output), '--startup-wait', '2',
                        '--ready', 'Opus 5', '--accept-theme', '--wait', '1', '--keys', '/model', '--keys', r'\r', '--',
                        *command, '--model', 'claude-opus-5', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
                       cwd=work, env=capture_environment, check=True, stdout=subprocess.DEVNULL)
        screen = json.loads(output.with_suffix('.json').read_text())[-1]['screen']
        if 'Select model' not in '\n'.join(screen):
            raise AssertionError(f'{name}: original model picker was not shown')
        outputs.append(screen)
if outputs[0] != outputs[1]:
    diffs = [(i+1, a, b) for i, (a, b) in enumerate(zip(*outputs)) if a != b]
    raise AssertionError(f'The original and SDK UI differ: {diffs}')
print('PASS: original and SDK-connected model pickers have identical terminal screens (compiled catalog fixture)')
