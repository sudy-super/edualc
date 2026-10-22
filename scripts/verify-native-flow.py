# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Exercise the installed native TUI/SDK bridge against a local Messages fixture."""
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import tempfile
import termios
import threading
import time
import uuid
import pyte
from fixture_processes import stop_isolated_processes

SOURCE_ROOT = Path(__file__).resolve().parents[1]
ROOT = Path(os.environ.get('EDUALC_APP_ROOT', SOURCE_ROOT)).resolve()
MANIFEST = json.loads((ROOT / 'native/manifest.json').read_text())
ORIGINAL = Path(MANIFEST['binary']).resolve(strict=True)
SDK = Path(os.environ.get('EDUALC_SDK_PACKAGE', str(Path.home()/'.local/share/edualc/sdk/current/node_modules/@anthropic-ai/claude-agent-sdk'))).resolve(strict=True)
ARTIFACT = ROOT / 'test/artifacts/native-flow'
ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
KEY = 'sk-edualc-native-fixture'
SESSION = str(uuid.uuid4())
phase = 'initial'
requests = []
write_issued = False
work = None


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        global write_issued
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or '{}')
        if 'count_tokens' in self.path:
            self.respond({'input_tokens': 100})
            return
        if not self.path.split('?')[0].rstrip('/').endswith('/messages'):
            self.respond({})
            return
        requests.append({'phase': phase, 'path': self.path, 'body': body, 'private_key': self.headers.get('x-api-key') == KEY, 'bearer': self.headers.get('authorization') is not None, 'sdk': 'agent-sdk/' in self.headers.get('user-agent', '')})
        text = f'NATIVE_{phase.upper()}_OK. Remember MEMORY_3179.'
        content = [{'type': 'text', 'text': text}]
        stop = 'end_turn'
        if phase == 'write' and not write_issued and any(t.get('name') == 'Write' for t in body.get('tools', [])):
            write_issued = True
            content = [{'type': 'tool_use', 'id': 'toolu_native_write', 'name': 'Write',
                        'input': {'file_path': str(work / 'fixture.txt'), 'content': 'MEMORY_3179\n'}}]
            stop = 'tool_use'
        result = {'id': f'msg_native_{len(requests)}', 'type': 'message', 'role': 'assistant',
                  'model': body.get('model', 'claude-opus-5'), 'content': content,
                  'stop_reason': stop, 'stop_sequence': None,
                  'usage': {'input_tokens': 100, 'output_tokens': 25}}
        if not body.get('stream'):
            self.respond(result)
            return
        frames = [('message_start', {'type': 'message_start', 'message': {**result, 'content': [],
                    'stop_reason': None, 'usage': {'input_tokens': 100, 'output_tokens': 0}}})]
        block = content[0]
        initial = {'type': 'text', 'text': ''} if block['type'] == 'text' else {**block, 'input': {}}
        delta = {'type': 'text_delta', 'text': text} if block['type'] == 'text' else {
                    'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])}
        frames += [('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': initial}),
                   ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': delta}),
                   ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                   ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop,
                       'stop_sequence': None}, 'usage': {'output_tokens': 25}}),
                   ('message_stop', {'type': 'message_stop'})]
        data = ''.join(f'event: {event}\ndata: {json.dumps(value)}\n\n' for event, value in frames).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def respond(self, obj):
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Terminal:
    def __init__(self, environment, arguments, name, binary=None):
        self.name, self.raw = name, bytearray()
        self.screen = pyte.Screen(110, 40)
        self.stream = pyte.ByteStream(self.screen)
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 110, 0, 0))
        self.process = subprocess.Popen([str(binary or ROOT / 'native/edualc'), *arguments], cwd=work,
                       env=environment, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)

    def drain(self, duration=.1):
        until = time.monotonic() + duration
        while time.monotonic() < until:
            if select.select([self.master], [], [], min(.05, max(0, until-time.monotonic())))[0]:
                try:
                    data = os.read(self.master, 65536)
                except OSError:
                    return
                self.raw.extend(data)
                self.stream.feed(data)
                ARTIFACT.with_name(f'native-flow-{self.name}.txt').write_text('\n'.join(self.screen.display)+'\n')

    def send(self, text):
        os.write(self.master, text.encode())

    def wait(self, text, timeout=45):
        print(f'{self.name}: waiting for {text}', flush=True)
        until = time.monotonic() + timeout
        while text not in '\n'.join(self.screen.display):
            self.drain()
            display = '\n'.join(self.screen.display)
            if text == 'Opus 5' and 'Choose the text style' in display:
                self.send('\r')
                self.drain(.3)
            if text == 'Opus 5' and 'Yes, I trust this folder' in display:
                self.send('\x1b[B\r')
                self.drain(.3)
            if self.process.poll() is not None:
                raise AssertionError(f'{self.name}: exited {self.process.returncode} waiting for {text}')
            if time.monotonic() > until:
                raise AssertionError(f'{self.name}: timed out waiting for {text}')

    def stop(self):
        self.drain()
        ARTIFACT.with_name(f'native-flow-{self.name}.ansi').write_bytes(self.raw)
        ARTIFACT.with_name(f'native-flow-{self.name}.txt').write_text('\n'.join(self.screen.display)+'\n')
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        os.close(self.master)


if not (ROOT / 'native/edualc').exists():
    raise SystemExit('Generate native/edualc before running this verification.')
server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
terminal = None
checks = []
audit = SOURCE_ROOT / 'test/artifacts/parent-api-audit.jsonl'
audit_start = audit.stat().st_size if audit.exists() else 0
temporary = tempfile.TemporaryDirectory(prefix='edualc-native-flow-')
try:
    home = Path(temporary.name).resolve()
    work = home / 'work'
    work.mkdir()
    (home / '.claude').mkdir()
    (home/'.claude/CLAUDE.md').write_text('EDUALC_MEMORY_INSTRUCTION_ONCE_49173. Use this instruction in fixture conversations.\n')
    skill_dir = home/'.claude/skills/edualc-fixture'
    skill_dir.mkdir(parents=True)
    (skill_dir/'SKILL.md').write_text('---\nname: edualc-fixture\ndescription: EDUALC_SKILL_CATALOG_ONCE_5903 use for fixture arithmetic verification\n---\nUse only for local fixture tests.\n')
    (home / '.edualc').mkdir()
    (home / '.edualc/settings.json').write_text(json.dumps({'env': {'ANTHROPIC_API_KEY': KEY}}))
    sdk_current = home/'.local/share/edualc/sdk/current'
    sdk_current.parent.mkdir(parents=True)
    sdk_current.symlink_to(SDK.parents[2])
    (home / '.claude/settings.json').write_text(json.dumps({'tui': 'fullscreen', 'disableAllHooks': True, 'theme': 'dark'}))
    (home / '.claude.json').write_text(json.dumps({'hasCompletedOnboarding': True,
        'theme': 'dark', 'customApiKeyResponses': {'approved': [KEY[-20:]], 'rejected': []},
        'projects': {str(work): {'hasTrustDialogAccepted': True}}}))
    environment = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'CLAUDE_', 'EDUALC_'))}
    environment.update({'HOME': str(home),
        'CLAUDE_SECURESTORAGE_CONFIG_DIR': str(home/'.edualc'), 'ANTHROPIC_API_KEY': KEY,
        'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}',
        'EDUALC_SDK_PACKAGE': str(SDK), 'EDUALC_AUDIT_APP_ROOT': str(ROOT), 'CLAUDE_CODE_MODEL_CATALOG': 'off',
        'DISABLE_AUTOUPDATER': '1', 'DISABLE_NON_ESSENTIAL_MODEL_CALLS': '1',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'TERM': 'xterm-256color',
        'BUN_OPTIONS': f'--preload={SOURCE_ROOT / "scripts/audit-parent-api.mjs"}',
        'HTTP_PROXY': '', 'HTTPS_PROXY': '', 'ALL_PROXY': '',
        'http_proxy': '', 'https_proxy': '', 'all_proxy': '', 'NO_PROXY': '*', 'no_proxy': '*'})
    common = ['--model', 'claude-opus-5', '--permission-mode', 'default', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
    original_environment = {**environment, 'BUN_OPTIONS': ''}
    terminal = Terminal(original_environment, [*common, '--session-id', SESSION], 'original', ORIGINAL)
    terminal.wait('Opus 5')
    terminal.send('Remember ORIGINAL_MEMORY_8412. Reply briefly.\r')
    terminal.wait('NATIVE_INITIAL_OK')
    terminal.send('/exit\r')
    terminal.drain(1)
    terminal.stop()
    checks.append('original Claude Code creates shared transcript')
    environment.update({'ANTHROPIC_API_KEY': '', 'CLAUDE_CODE_OAUTH_TOKEN': 'original-oauth-fixture',
        'EDUALC_AUTH_SETTINGS_FILE': str(home/'.edualc/runtime-auth.json')})
    subprocess.run([str(ROOT/'bin/edualc-direct'), '--version'], env=environment, capture_output=True, check=True)
    phase = 'handoff'
    terminal = Terminal(environment, [*common, '--resume', SESSION], 'main')
    terminal.wait('Opus 5')
    terminal.send('Remember MEMORY_3179. Reply briefly.\r')
    terminal.wait('NATIVE_HANDOFF_OK')
    checks.append('edualc resumes original Claude Code transcript using dedicated key')
    assert 'ORIGINAL_MEMORY_8412' in json.dumps(requests[-1]['body'])
    phase = 'write'
    terminal.send('Write MEMORY_3179 into fixture.txt using the Write tool.\r')
    terminal.wait('Do you want')
    terminal.drain(.5)
    terminal.send('\r')
    terminal.wait('NATIVE_WRITE_OK')
    assert (work/'fixture.txt').read_text() == 'MEMORY_3179\n'
    checks.append('native Write approval and SDK tool execution')
    phase = 'compact'
    terminal.send('/compact Preserve MEMORY_3179.\r')
    terminal.wait('Compacted', timeout=60)
    checks.append('SDK compact')
    phase = 'continuation'
    terminal.send('What code did I ask you to remember?\r')
    terminal.wait('NATIVE_CONTINUATION_OK')
    checks.append('conversation after compact')
    phase = 'side'
    terminal.send('/btw What is the remembered code?\r')
    terminal.wait('NATIVE_SIDE_OK')
    checks.append('SDK side question')
    terminal.send('\x1b')
    terminal.drain(.4)
    terminal.send('/exit\r')
    terminal.drain(1)
    terminal.stop()
    terminal = None
    histories = list((home/'.claude/projects').rglob(f'{SESSION}.jsonl'))
    assert len(histories) == 1, histories
    history = [json.loads(line) for line in histories[0].read_text().splitlines()]
    assert any(row.get('type') == 'assistant' for row in history)
    phase = 'resume'
    terminal = Terminal(environment, [*common, '--resume', SESSION], 'resume')
    terminal.wait('Opus 5')
    terminal.send('Resume and recall the remembered code.\r')
    terminal.wait('NATIVE_RESUME_OK')
    checks.append('resume using parent session ID')
    for history_phase in ['continuation', 'side', 'resume']:
        matching = [request for request in requests if request['phase'] == history_phase]
        assert matching and 'MEMORY_3179' in json.dumps(matching[0]['body']), history_phase
    checks.append('post-compact, side, and resumed requests contain saved memory')
    terminal.send('/exit\r')
    terminal.drain(1)
    terminal.stop()
    phase = 'fresh'
    fresh_id = str(uuid.uuid4())
    terminal = Terminal(environment, [*common, '--session-id', fresh_id], 'fresh')
    terminal.wait('Opus 5')
    terminal.send('Reply briefly in this new conversation.\r')
    terminal.wait('NATIVE_FRESH_OK')
    terminal.send('/exit\r')
    terminal.drain(1)
    terminal.stop()
    phase = 'fresh-resume'
    terminal = Terminal(environment, [*common, '--resume', fresh_id], 'fresh-resume')
    terminal.wait('Opus 5')
    terminal.send('Reply briefly after resuming this new conversation.\r')
    terminal.wait('NATIVE_FRESH-RESUME_OK')
    assert not audit.exists() or audit.stat().st_size == audit_start, 'TUI parent sent a model request'
    checks.append('zero parent model requests')
    sdk_requests = [r for r in requests if r['sdk']]
    assert sdk_requests and all(r['private_key'] and not r['bearer'] for r in sdk_requests)
    checks.append('every SDK model request uses dedicated key without original OAuth')
    for catalog_phase in ['handoff', 'fresh', 'fresh-resume']:
        body = next(r['body'] for r in sdk_requests if r['phase']==catalog_phase and any(t.get('name')=='Skill' for t in r['body'].get('tools',[])))
        catalog_text = json.dumps({'system':body.get('system'), 'messages':body.get('messages')}, ensure_ascii=False)
        assert catalog_text.count('EDUALC_SKILL_CATALOG_ONCE_5903') == 1, (catalog_phase, 'skill catalog repetitions', catalog_text.count('EDUALC_SKILL_CATALOG_ONCE_5903'))
    checks.append('SDK skill description occurs exactly once in the actual model request')
    for memory_phase in ['handoff', 'fresh', 'fresh-resume']:
        body = next(r['body'] for r in sdk_requests if r['phase']==memory_phase and any(t.get('name')=='Skill' for t in r['body'].get('tools',[])))
        text = json.dumps({'system':body.get('system'), 'messages':body.get('messages')}, ensure_ascii=False)
        assert text.count('EDUALC_MEMORY_INSTRUCTION_ONCE_49173') == 1, (memory_phase, 'memory instruction repetitions', text.count('EDUALC_MEMORY_INSTRUCTION_ONCE_49173'))
    checks.append('shared CLAUDE.md occurs exactly once in the actual model request')
    print('PASS: '+', '.join(checks))
finally:
    if terminal is not None:
        terminal.stop()
    server.shutdown()
    stop_isolated_processes(home)
    temporary.cleanup()
    ARTIFACT.with_suffix('.json').write_text(json.dumps({'session': SESSION, 'checks': checks,
                    'requests': requests}, ensure_ascii=False, indent=2)+'\n')
