# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Verify original /context rendering reads the SDK, before and after a turn."""
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

ROOT = Path(os.environ.get('EDUALC_APP_ROOT', Path(__file__).resolve().parents[1])).resolve()
MANIFEST = json.loads((ROOT / 'native/manifest.json').read_text())
ORIGINAL = Path(MANIFEST['binary']).resolve(strict=True)
VERIFY_API_ERROR = os.environ.get('EDUALC_VERIFY_API_ERROR') == '1'
VERIFY_ORIGINAL = os.environ.get('EDUALC_VERIFY_ORIGINAL') == '1'
ARTIFACT = ROOT / 'test/artifacts' / (('api-error-original' if VERIFY_ORIGINAL else 'api-error-edualc') if VERIFY_API_ERROR else 'context')
ARTIFACT.mkdir(parents=True, exist_ok=True)
SDK_ROOT = Path(os.environ.get('EDUALC_SDK_PACKAGE', str(Path.home()/'.local/share/edualc/sdk/current/node_modules/@anthropic-ai/claude-agent-sdk'))).resolve(strict=True).parents[2]
KEY = 'sk-edualc-context-fixture'
SKILL_MARKER = 'CONTEXT_SKILL_DESCRIPTION_ONCE_793261'
MEMORY_MARKER = 'CONTEXT_MEMORY_INSTRUCTION_ONCE_18379'
SKILL_BODY = 'SKILL_PRIVATE_BODY_629183'
SKILL_ANSWER = 'SKILL_LOADED_ANSWER_48219'
model_requests = []
requests = []
model_probe_reject = 0
model_probe_target = None
retry_issued = False


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        global retry_issued
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or '{}')
        requests.append({'path': self.path, 'sdk': 'agent-sdk/' in self.headers.get('user-agent', ''),
                         'private_key': self.headers.get('x-api-key') == KEY, 'model': body.get('model'), 'max_tokens': body.get('max_tokens'), 'probe_messages': body.get('messages') if self.headers.get('x-api-key') != KEY else None})
        if VERIFY_API_ERROR and 'count_tokens' not in self.path:
            data = json.dumps({'type': 'error', 'error': {'type': 'authentication_error', 'message': 'DENIED_COMPARE_401'}}).encode()
            self.send_response(401)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if 'count_tokens' not in self.path and body.get('stream') and body.get('tools') and not retry_issued and 'Reply briefly.' in json.dumps(body.get('messages', [])):
            retry_issued = True
            data = json.dumps({'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'RETRY_FIXTURE_529'}}).encode()
            self.send_response(529)
            self.send_header('content-type', 'application/json')
            self.send_header('retry-after', '5')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if 'count_tokens' not in self.path and body.get('model') == 'claude-opus-5' and 'FALLBACK_PROBE_738192' in json.dumps(body.get('messages', [])):
            data = json.dumps({'type': 'error', 'error': {'type': 'not_found_error', 'message': 'fixture primary unavailable'}}).encode()
            self.send_response(404)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if model_probe_reject and body.get('model') == model_probe_target and body.get('max_tokens') == 1 and 'count_tokens' not in self.path:
            data = json.dumps({'type': 'error', 'error': {'type': 'authentication_error' if model_probe_reject == 401 else 'not_found_error', 'message': 'fixture validation rejected'}}).encode()
            self.send_response(model_probe_reject)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if 'count_tokens' in self.path:
            result = {'input_tokens': 37}
        else:
            assert self.path.split('?')[0].endswith('/messages'), self.path
            if body.get('stream') and body.get('tools') and 'Reply briefly.' in json.dumps(body.get('messages', [])):
                model_requests.append(body)
            result = {'id': 'msg_context_fixture_' + str(len(requests)), 'type': 'message', 'role': 'assistant',
                      'model': body.get('model'), 'content': [{'type': 'text', 'text': 'CONTEXT_TURN_OK_7841'}],
                      'stop_reason': 'end_turn', 'stop_sequence': None,
                      'usage': {'input_tokens': 37, 'output_tokens': 10}}
        if 'count_tokens' not in self.path and 'Load context-fixture using Skill.' in json.dumps(body.get('messages', [])):
            if SKILL_BODY in json.dumps(body.get('messages', [])):
                result['content'] = [{'type': 'text', 'text': SKILL_ANSWER}]
            else:
                result['content'] = [{'type': 'tool_use', 'id': 'toolu_skill_fixture', 'name': 'Skill', 'input': {'skill': 'context-fixture'}}]
                result['stop_reason'] = 'tool_use'
        if 'count_tokens' not in self.path and 'STATE_MODEL_SIDE_196283' in json.dumps(body.get('messages', [])):
            result['content'] = [{'type': 'text', 'text': 'STATE_SIDE_ANSWER_482197'}]
            result['stop_reason'] = 'end_turn'
        if 'count_tokens' not in self.path and 'FALLBACK_PROBE_738192' in json.dumps(body.get('messages', [])):
            result['content'] = [{'type': 'text', 'text': 'FALLBACK_ANSWER_941827'}]
            result['stop_reason'] = 'end_turn'
        content_type = 'application/json'
        data = json.dumps(result).encode()
        if body.get('stream') and 'content' in result:
            frames = [('message_start', {'type': 'message_start', 'message': {**result, 'content': [], 'stop_reason': None}})]
            block = result['content'][0]
            is_tool = block['type'] == 'tool_use'
            frames += [
                ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {**block, 'input': {}} if is_tool else {'type': 'text', 'text': ''}}),
                ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])} if is_tool else {'type': 'text_delta', 'text': block['text']}}),
                ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': result['stop_reason'], 'stop_sequence': None}, 'usage': {'output_tokens': 10}}),
                ('message_stop', {'type': 'message_stop'})]
            data = ''.join(f'event: {event}\ndata: {json.dumps(value)}\n\n' for event, value in frames).encode()
            content_type = 'text/event-stream'
        self.send_response(200)
        self.send_header('content-type', content_type)
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Terminal:
    def __init__(self, environment, work):
        self.raw = bytearray()
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 130, 0, 0))
        self.screen = pyte.Screen(130, 45)
        self.stream = pyte.ByteStream(self.screen)
        executable = ORIGINAL if VERIFY_ORIGINAL else ROOT / 'bin/edualc-direct'
        self.process = subprocess.Popen([str(executable), '--model', 'claude-sonnet-4-5', '--fallback-model', 'claude-sonnet-5',
                                         '--permission-mode', 'default', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
                                        cwd=work, env=environment, stdin=slave, stdout=slave, stderr=slave,
                                        start_new_session=True)
        os.close(slave)

    def send(self, text):
        os.write(self.master, text.encode())

    def drain(self, duration=.15):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            if not select.select([self.master], [], [], .02)[0]:
                continue
            try:
                data = os.read(self.master, 65536)
            except OSError:
                break
            if not data:
                break
            self.raw.extend(data)
            self.stream.feed(data)

    def wait(self, text, timeout=30):
        deadline = time.monotonic() + timeout
        while text not in '\n'.join(self.screen.display):
            self.drain()
            if self.process.poll() is not None:
                raise AssertionError(f'Exited {self.process.returncode} waiting for {text}')
            if 'Choose the text style' in '\n'.join(self.screen.display):
                self.send('\r')
            if time.monotonic() > deadline:
                raise AssertionError(f'Timeout waiting for {text}: ' + '\n'.join(self.screen.display))

    def capture(self, name):
        (ARTIFACT / f'{name}.txt').write_text('\n'.join(self.screen.display) + '\n')
        (ARTIFACT / f'{name}.ansi').write_bytes(self.raw)

    def stop(self):
        self.capture('last')
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        os.close(self.master)


server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
temporary = tempfile.TemporaryDirectory(prefix='edualc-context-')
home = Path(temporary.name).resolve()
terminal = None
checks = []
try:
    work = home / 'work'
    work.mkdir()
    (home / '.claude').mkdir()
    (home / '.claude/CLAUDE.md').write_text(MEMORY_MARKER + '. Follow this fixture instruction.\n')
    (home / '.edualc').mkdir()
    skill = home / '.claude/skills/context-fixture'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text('---\nname: context-fixture\ndescription: ' + SKILL_MARKER + '\n---\n' + SKILL_BODY + '. Use this fixture only when asked for context-fixture.\n')
    (home / '.edualc/settings.json').write_text(json.dumps({'env': {'ANTHROPIC_API_KEY': KEY}}))
    hook_mode = home / 'compact-hook-mode'
    hook_mode.write_text('block')
    compact_hook = home / 'compact-hook.py'
    compact_hook.write_text('import pathlib,sys\nmode=pathlib.Path(' + repr(str(hook_mode)) + ').read_text()\nif mode=="block":\n print("COMPACT_BLOCK_REASON_428193",file=sys.stderr)\n sys.exit(2)\nprint("COMPACT_HOOK_COMPLETED_573981")\n')
    stop_hook = home / 'stop-hook.py'
    stop_hook.write_text('import json,os\nprint(json.dumps({"systemMessage":"SDK_STOP_NOTICE_837291"} if os.environ.get("ANTHROPIC_API_KEY")=='+repr(KEY)+' else {}))\n')
    (home / '.claude/settings.json').write_text(json.dumps({'tui': 'fullscreen', 'theme': 'dark',
        'hooks': {'PreCompact': [{'matcher': 'manual', 'hooks': [{'type': 'command', 'command': 'python3 ' + str(compact_hook)}]}],
                  'Stop': [{'hooks': [{'type': 'command', 'command': 'python3 ' + str(stop_hook)}]}]}}))
    (home / '.claude.json').write_text(json.dumps({'hasCompletedOnboarding': True, 'theme': 'dark',
        'projects': {str(work): {'hasTrustDialogAccepted': True}}}))
    current = home / '.local/share/edualc/sdk/current'
    current.parent.mkdir(parents=True)
    current.symlink_to(SDK_ROOT)
    environment = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'CLAUDE_', 'EDUALC_'))}
    environment.update({'HOME': str(home), 'TERM': 'xterm-256color',
        'EDUALC_TRACE': '1',
        'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}',
        'CLAUDE_CODE_OAUTH_TOKEN': 'original-oauth-fixture',
        'CLAUDE_CODE_MODEL_CATALOG': 'off', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
        'DISABLE_AUTOUPDATER': '1', 'DISABLE_NON_ESSENTIAL_MODEL_CALLS': '1',
        'HTTP_PROXY': '', 'HTTPS_PROXY': '', 'ALL_PROXY': '',
        'http_proxy': '', 'https_proxy': '', 'all_proxy': '', 'NO_PROXY': '*', 'no_proxy': '*'})
    if VERIFY_API_ERROR:
        environment['CLAUDE_CODE_MAX_RETRIES'] = '0'
    terminal = Terminal(environment, work)
    terminal.wait('Sonnet 4.5')
    if VERIFY_API_ERROR:
        terminal.send('401 comparison fixture\r')
        terminal.wait('API Error: 401')
        terminal.drain(2)
        terminal.capture('api-error-original' if VERIFY_ORIGINAL else 'api-error-edualc')
        assert '\n'.join(terminal.screen.display).count('DENIED_COMPARE_401') == 1, 'API failure displayed more than once'
        if not VERIFY_ORIGINAL:
            assert requests and all(request['sdk'] and request['private_key'] for request in requests)
        checks.append('native API failure is displayed once without rethrowing the same SDK failure')
        print('PASS: ' + checks[-1])
        raise SystemExit(0)
    terminal.send('/context\r')
    terminal.wait('Context Usage')
    terminal.drain(.5)
    terminal.capture('before-turn')
    assert requests and all('count_tokens' in r['path'] and r['sdk'] and r['private_key'] for r in requests), requests
    checks.append('initial /context uses SDK count API without generating a response')
    terminal.send('\x1bt')
    terminal.wait('Toggle thinking mode')
    terminal.send('\x1b[B\r')
    terminal.wait('Thinking off')
    terminal.send('Reply briefly.\r')
    terminal.wait('Retrying')
    terminal.capture('api-retry')
    terminal.wait('CONTEXT_TURN_OK_7841')
    checks.append('SDK API retry reaches native countdown before the successful response')
    terminal.wait('STOP_NOTICE_837291')
    terminal.drain(1)
    terminal.capture('stop-hook-notice')
    checks.append('SDK-only Stop hook notice reaches the original TUI')
    assert model_requests, 'No generated model request after initial /context'
    assert all(request.get('thinking', {}).get('type') in (None, 'disabled') for request in model_requests), 'Thinking off ignored by SDK'
    checks.append('native Thinking off disables thinking in the actual SDK API request')
    counts = [json.dumps({'system': request.get('system'), 'messages': request.get('messages')}).count(SKILL_MARKER) for request in model_requests]
    assert all(count == 1 for count in counts), counts
    checks.append('initial /context preserves exactly one skill description in following generation')
    memory_counts = [json.dumps({'system': request.get('system'), 'messages': request.get('messages')}).count(MEMORY_MARKER) for request in model_requests]
    assert memory_counts and all(count == 1 for count in memory_counts), memory_counts
    checks.append('initial /context preserves exactly one CLAUDE.md instruction in following generation')
    terminal.send('\x1bt')
    terminal.wait('Toggle thinking mode')
    terminal.send('\x1b[A\r')
    terminal.wait('Do you want to proceed?')
    terminal.send('\r')
    terminal.wait('Thinking on')
    enabled_start = len(model_requests)
    terminal.send('Load context-fixture using Skill.\r')
    terminal.wait('LOADED_ANSWER_48219')
    terminal.drain(.5)
    terminal.capture('skill-loaded')
    assert len(model_requests) > enabled_start and all(request.get('thinking', {}).get('type') == 'enabled' for request in model_requests[enabled_start:]), 'Thinking on ignored by SDK'
    checks.append('native Thinking on reenables thinking before the next SDK turn')
    assert SKILL_BODY not in '\n'.join(terminal.screen.display), 'Synthetic skill body leaked into visible conversation'
    checks.append('SDK Skill receives its body while the original TUI hides the synthetic message')
    before_compact = len(requests)
    terminal.send('/compact\r')
    terminal.wait('BLOCK_REASON_428193')
    terminal.drain(.5)
    terminal.capture('compact-blocked')
    assert 'The SDK did not return a compaction boundary' not in '\n'.join(terminal.screen.display)
    assert not any('count_tokens' not in request['path'] for request in requests[before_compact:]), 'Blocked compaction called the model'
    checks.append('PreCompact hook rejection keeps its original reason without a model request')
    hook_mode.write_text('allow')
    terminal.send('/compact\r')
    terminal.wait('HOOK_COMPLETED_573981')
    terminal.drain(.5)
    terminal.capture('compact-completed')
    checks.append('successful compaction displays the SDK PreCompact hook output')
    compacted_transcripts = 0
    for transcript in (home / '.claude/projects').glob('**/*.jsonl'):
        rows = [json.loads(line) for line in transcript.read_text().splitlines()]
        ids = {row.get('uuid') for row in rows}
        for row in rows:
            if row.get('subtype') == 'compact_boundary':
                retained = row.get('compactMetadata', {}).get('preservedMessages', {}).get('uuids', [])
                assert set(retained) <= ids, (transcript.name, set(retained) - ids)
                compacted_transcripts += 1
    assert compacted_transcripts >= 2, 'Expected both SDK and shared parent compaction histories'
    checks.append('shared and SDK histories persist every retained compaction row, including hooks')
    model_probe_reject, model_probe_target = 401, 'claude-sonnet-5'
    terminal.send('/model claude-sonnet-5\r')
    terminal.wait('check your API credentials')
    terminal.drain(.3)
    checks.append('model validation uses dedicated SDK authentication and retains the native 401 classification')
    model_probe_reject = 0
    terminal.send('/model claude-sonnet-5\r')
    terminal.wait('model?')
    terminal.send('\r')
    terminal.drain(.7)
    side_start = len(requests)
    terminal.send('/btw STATE_MODEL_SIDE_196283\r')
    terminal.wait('SIDE_ANSWER_482197')
    terminal.drain(.5)
    side_requests = [request for request in requests[side_start:] if 'count_tokens' not in request['path']]
    assert side_requests and all(request['model'] == 'claude-sonnet-5' for request in side_requests), side_requests
    checks.append('side question uses the model changed before any new conversation turn')
    terminal.send('\x1b')
    terminal.drain(.3)
    model_probe_reject, model_probe_target = 404, 'claude-opus-5'
    terminal.send('/model claude-opus-5\r')
    terminal.wait('not found')
    terminal.drain(.3)
    checks.append('model validation retains the native 404 classification')
    model_probe_reject = 0
    terminal.send('/model claude-opus-5\r')
    terminal.drain(.7)
    boundary = len(requests)
    terminal.send('/context\r')
    deadline = time.monotonic() + 30
    while len(requests) == boundary and time.monotonic() < deadline:
        terminal.drain()
    terminal.wait('Context Usage')
    terminal.drain(1)
    terminal.capture('after-turn')
    assert len(requests) > boundary and all('count_tokens' in r['path'] for r in requests[boundary:]), requests[boundary:]
    assert all(r['sdk'] and r['private_key'] for r in requests), requests
    assert all(request['model'] == 'claude-opus-5' for request in requests[boundary:]), requests[boundary:]
    checks.append('context inspection applies a model change without generating a new conversation turn')
    checks.append('post-turn /context uses SDK count API and original renderer')
    fallback_start = len(requests)
    terminal.send('FALLBACK_PROBE_738192\r')
    terminal.wait('FALLBACK_ANSWER_941827')
    terminal.wait('because Opus 5 is not available')
    terminal.drain(.5)
    terminal.capture('model-fallback')
    generated_models = [request['model'] for request in requests[fallback_start:] if 'count_tokens' not in request['path']]
    assert 'claude-opus-5' in generated_models and 'claude-sonnet-5' in generated_models, generated_models
    assert all(request['sdk'] and request['private_key'] for request in requests[fallback_start:])
    checks.append('SDK model fallback executes the configured model and renders the native switch warning')
    print('PASS: ' + ', '.join(checks))
finally:
    if terminal:
        terminal.stop()
    server.shutdown()
    stop_isolated_processes(home)
    temporary.cleanup()
    (ARTIFACT / 'result.json').write_text(json.dumps({'checks': checks, 'requests': requests, 'skill_marker_counts': [json.dumps({'system': r.get('system'), 'messages': r.get('messages')}).count(SKILL_MARKER) for r in model_requests]}, indent=2) + '\n')
