# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Compare keyboard actions in isolated original and SDK-connected terminals."""
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

import pyte
from fixture_processes import stop_isolated_processes

REPO = Path(__file__).resolve().parents[1]
APP = Path(os.environ.get('EDUALC_APP_ROOT', REPO))
OUT = REPO / 'test/artifacts/shortcuts'
OUT.mkdir(parents=True, exist_ok=True)
KEY = 'sk-shortcuts-local-fixture'
requests = []


class API(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        requests.append({'privateKey': self.headers.get('x-api-key') == KEY, 'body': body})
        reply = 'SHORTCUT_THINKING_REPLY_418291' if 'SHORTCUT_THINKING_918235' in json.dumps(body.get('messages', [])) else 'SHORTCUT_REPLY_581729'
        result = {'input_tokens': 10} if 'count_tokens' in self.path else {
            'id': 'msg_shortcuts', 'type': 'message', 'role': 'assistant', 'model': body['model'],
            'content': [{'type': 'text', 'text': reply}],
            'stop_reason': 'end_turn', 'stop_sequence': None,
            'usage': {'input_tokens': 10, 'output_tokens': 10},
        }
        data = json.dumps(result).encode()
        if body.get('stream') and 'content' in result:
            frames = [
                ('message_start', {'type': 'message_start', 'message': {**result, 'content': [], 'stop_reason': None}}),
                ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': reply}}),
                ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 10}}),
                ('message_stop', {'type': 'message_stop'}),
            ]
            data = ''.join(f'event: {event}\ndata: {json.dumps(value)}\n\n' for event, value in frames).encode()
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream' if body.get('stream') and 'content' in result else 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


server = ThreadingHTTPServer(('127.0.0.1', 0), API)
threading.Thread(target=server.serve_forever, daemon=True).start()
results = {}
try:
    for app in ['original', 'edualc']:
        request_offset = len(requests)
        with tempfile.TemporaryDirectory(prefix='edualc-shortcuts-') as temporary:
            home = Path(temporary).resolve()
            work = home / 'work'
            work.mkdir()
            (home / '.claude').mkdir()
            (home / '.edualc').mkdir()
            (home / '.claude/settings.json').write_text(json.dumps({
                'disableAllHooks': True, 'theme': 'dark', 'tui': 'fullscreen',
            }))
            (home / '.edualc/settings.json').write_text(json.dumps({'env': {'ANTHROPIC_API_KEY': KEY}}))
            (home / '.claude.json').write_text(json.dumps({
                'hasCompletedOnboarding': True, 'theme': 'dark',
                'projects': {str(work): {'hasTrustDialogAccepted': True}},
                'customApiKeyResponses': {'approved': [KEY], 'rejected': []},
            }))
            current = home / '.local/share/edualc/sdk/current'
            current.parent.mkdir(parents=True)
            current.symlink_to((Path.home() / '.local/share/edualc/sdk/current').resolve())
            env = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'CLAUDE_', 'EDUALC_', 'BUN_'))}
            env.update(HOME=str(home), TERM='xterm-256color', ANTHROPIC_API_KEY=KEY,
                       ANTHROPIC_BASE_URL=f'http://127.0.0.1:{server.server_port}',
                       CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_AUTOUPDATER='1',
                       DISABLE_NON_ESSENTIAL_MODEL_CALLS='1', ENABLE_TOOL_SEARCH='false',
                       HTTP_PROXY='', HTTPS_PROXY='', ALL_PROXY='', NO_PROXY='*',
                       http_proxy='', https_proxy='', all_proxy='', no_proxy='*')
            executable = Path.home() / '.local/share/claude/versions/2.1.302' if app == 'original' else APP / 'bin/edualc-direct'
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 130, 0, 0))
            process = subprocess.Popen([str(executable), '--model', 'claude-sonnet-4-5',
                                        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
                                       env=env, cwd=work, stdin=slave, stdout=slave, stderr=slave,
                                       start_new_session=True)
            os.close(slave)
            screen = pyte.Screen(130, 45)
            stream = pyte.ByteStream(screen)
            raw = bytearray()
            checks = []

            def text():
                return '\n'.join(screen.display)

            def drain(seconds=.35):
                until = time.monotonic() + seconds
                while time.monotonic() < until:
                    if select.select([master], [], [], .02)[0]:
                        try:
                            data = os.read(master, 65536)
                        except OSError:
                            return
                        if not data:
                            return
                        raw.extend(data)
                        stream.feed(data)

            def wait(predicate, reason, timeout=20):
                until = time.monotonic() + timeout
                while not predicate():
                    drain(.1)
                    if 'Do you want to use this API key?' in text():
                        os.write(master, b'\x1b[A\r')
                    if 'Choose the text style' in text():
                        os.write(master, b'\r')
                    if time.monotonic() > until or process.poll() is not None:
                        raise AssertionError(f'{app}: {reason}\n{text()}')

            def key(name, data, predicate):
                os.write(master, data)
                drain()
                wait(predicate, name)
                (OUT / f'{app}-{len(checks):02}-{name}.txt').write_text(text())
                checks.append(name)

            try:
                wait(lambda: 'Sonnet 4.5' in text(), 'startup')
                key('draft', b'SHORTCUT_DRAFT_913758', lambda: 'SHORTCUT_DRAFT_913758' in text())
                key('ctrl-l-preserves-draft', b'\x0c', lambda: 'SHORTCUT_DRAFT_913758' in text())
                key('ctrl-u-clear-input', b'\x15', lambda: 'SHORTCUT_DRAFT_913758' not in text())
                key('draft-for-stash', b'SHORTCUT_STASH_15379', lambda: 'SHORTCUT_STASH_15379' in text())
                key('ctrl-s-stash', b'\x13', lambda: 'stashed' in text().lower())
                key('ctrl-s-restore', b'\x13', lambda: 'SHORTCUT_STASH_15379' in text() and 'stashed' not in text().lower())
                key('ctrl-u-clear-restored', b'\x15', lambda: 'SHORTCUT_STASH_15379' not in text())
                key('option-p-model-picker', b'\x1bp', lambda: 'Select model' in text())
                key('esc-dismiss-picker', b'\x1b', lambda: 'Select model' not in text())
                key('shift-tab-permission', b'\x1b[Z', lambda: 'accept edits on' in text().lower())
                key('shift-tab-plan', b'\x1b[Z', lambda: 'plan mode on' in text().lower())
                key('shift-tab-default', b'\x1b[Z', lambda: 'plan mode on' not in text().lower() and 'accept edits on' not in text().lower())
                key('submit-history', b'SHORTCUT_HISTORY_71835\r', lambda: 'SHORTCUT_REPLY_581729' in text())
                wait(lambda: 'esc to interrupt' not in text().lower(), 'turn completion')
                key('up-history', b'\x1b[A', lambda: text().count('SHORTCUT_HISTORY_71835') >= 2)
                key('down-history', b'\x1b[B', lambda: text().count('SHORTCUT_HISTORY_71835') == 1)
                key('ctrl-r-history-search', b'\x12', lambda: 'search' in text().lower())
                key('ctrl-c-exit-search', b'\x03', lambda: 'search' not in text().lower())
                key('ctrl-o-transcript', b'\x0f', lambda: 'transcript' in text().lower())
                key('esc-exit-transcript', b'\x1b', lambda: 'transcript' not in text().lower())
                os.write(master, b'\x1b'); drain(.15)
                key('esc-esc-rewind', b'\x1b', lambda: 'Rewind' in text())
                key('esc-dismiss-rewind', b'\x1b', lambda: 'Rewind' not in text())
                key('option-t-thinking-picker', b'\x1bt', lambda: 'Toggle thinking mode' in text())
                key('thinking-picker-disable', b'\x1b[B\r', lambda: 'Do you want to proceed?' in text())
                key('thinking-confirm-mid-conversation', b'\r', lambda: 'Toggle thinking mode' not in text())
                key('option-t-thinking-request', b'SHORTCUT_THINKING_918235\r', lambda: 'SHORTCUT_THINKING_REPLY_418291' in text())
                wait(lambda: 'esc to interrupt' not in text().lower(), 'thinking turn completion')
                generated = [request['body'] for request in requests[request_offset:] if request['body'].get('tools')]
                assert len(generated) == 2, f'{app}: expected two conversation requests'
                assert generated[0].get('thinking') != generated[1].get('thinking'), f'{app}: thinking shortcut did not change request'
                (OUT / f'{app}-thinking.json').write_text(json.dumps([body.get('thinking') for body in generated], indent=2))
                key('ctrl-j-newline', b'FIRST_LINE_123\x0aSECOND_LINE_456', lambda: 'FIRST_LINE_123' in text() and 'SECOND_LINE_456' in text())
                os.write(master, b'\x15\x7f\x15'); drain()
                os.write(master, b'\x04'); drain(.2)
                assert 'Press Ctrl-D again' in text(), f'{app}: missing exit confirmation'
                os.write(master, b'\x04')
                until = time.monotonic() + 10
                while process.poll() is None and time.monotonic() < until:
                    drain(.1)
                assert process.poll() == 0, f'{app}: Ctrl+D did not exit cleanly'
                checks.append('ctrl-d-exit')
                results[app] = checks
                print(json.dumps({'app': app, 'checks': checks}), flush=True)
            finally:
                (OUT / f'{app}-requests.json').write_text(json.dumps(requests[request_offset:], indent=2))
                (OUT / f'{app}-last.txt').write_text(text())
                (OUT / f'{app}.ansi').write_bytes(raw)
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                os.close(master)
                stop_isolated_processes(home)
    assert results['original'] == results['edualc']
    assert (OUT / 'original-thinking.json').read_bytes() == (OUT / 'edualc-thinking.json').read_bytes()
    assert requests and all(request['privateKey'] for request in requests)
finally:
    (OUT / 'result.json').write_text(json.dumps({'checks': results}, indent=2))
    server.shutdown()
