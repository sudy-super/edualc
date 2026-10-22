# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Check native fullscreen, relaunch and API-key isolation using a local fixture."""
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
import sys
from contextlib import ExitStack
from fixture_processes import stop_isolated_processes

import pyte

ROOT = Path(os.environ.get('EDUALC_APP_ROOT', Path(__file__).resolve().parents[1])).resolve()
ARTIFACT = ROOT / 'test/artifacts/fullscreen'
ARTIFACT.mkdir(parents=True, exist_ok=True)
MANIFEST = json.loads((ROOT / 'native/manifest.json').read_text())
ORIGINAL = Path(MANIFEST['binary']).resolve(strict=True)
SDK = Path(os.environ.get('EDUALC_SDK_PACKAGE', str(Path.home()/'.local/share/edualc/sdk/current/node_modules/@anthropic-ai/claude-agent-sdk'))).resolve(strict=True)
KEY = 'sk-edualc-fullscreen-fixture'
requests = []
auth_headers = []
response_phase = 'DEFAULT'


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or '{}')
        if 'count_tokens' in self.path:
            result = {'input_tokens': 10}
        elif self.path.split('?')[0].endswith('/messages'):
            requests.append(body)
            auth_headers.append({'x-api-key':self.headers.get('x-api-key'),
                'authorization':self.headers.get('authorization'),
                'workspace':self.headers.get('anthropic-workspace-id'),
                'proxy_auth':self.headers.get('x-litellm-api-key')})
            response_text = f'FULLSCREEN_RELAUNCH_SDK_OK_{response_phase}'
            result = {'id': 'msg_fullscreen_fixture', 'type': 'message', 'role': 'assistant',
                'model': body.get('model', 'claude-opus-5'),
                'content': [{'type': 'text', 'text': response_text}],
                'stop_reason': 'end_turn', 'stop_sequence': None,
                'usage': {'input_tokens': 10, 'output_tokens': 10}}
        else:
            result = {}
        if body.get('stream') and 'content' in result:
            frames = [('message_start', {'type': 'message_start', 'message': {**result,
                'content': [], 'stop_reason': None}}),
                ('content_block_start', {'type': 'content_block_start', 'index': 0,
                    'content_block': {'type': 'text', 'text': ''}}),
                ('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                    'delta': {'type': 'text_delta', 'text': response_text}}),
                ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn',
                    'stop_sequence': None}, 'usage': {'output_tokens': 10}}),
                ('message_stop', {'type': 'message_stop'})]
            data = ''.join(f'event: {event}\ndata: {json.dumps(value)}\n\n' for event,value in frames).encode()
            content_type = 'text/event-stream'
        else:
            data = json.dumps(result).encode()
            content_type = 'application/json'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Terminal:
    def __init__(self, binary, environment, work):
        self.raw = bytearray()
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 110, 0, 0))
        self.screen = pyte.Screen(110, 40)
        self.stream = pyte.ByteStream(self.screen)
        self.process = subprocess.Popen([str(binary), '--model', 'claude-opus-5',
            '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
            cwd=work, env=environment, stdin=slave, stdout=slave, stderr=slave,
            start_new_session=True)
        os.close(slave)

    def drain(self, duration=.1):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            if not select.select([self.master], [], [], min(.05, max(0, deadline-time.monotonic())))[0]:
                continue
            try:
                data = os.read(self.master, 65536)
            except OSError:
                break
            if not data:
                break
            self.raw.extend(data)
            self.stream.feed(data)

    def send(self, text):
        os.write(self.master, text.encode())

    def wait(self, expected, timeout=25):
        deadline = time.monotonic() + timeout
        while expected not in '\n'.join(self.screen.display):
            if self.process.poll() is not None:
                raise AssertionError(f'Exited {self.process.returncode} before {expected}')
            if time.monotonic() > deadline:
                raise AssertionError(f'Timed out waiting for {expected}: ' + '\n'.join(self.screen.display))
            self.drain()
            display = '\n'.join(self.screen.display)
            if 'Choose the text style' in display:
                self.send('\r')
                self.drain(.3)

    def close(self, name):
        self.drain(.2)
        (ARTIFACT / f'{name}.ansi').write_bytes(self.raw)
        (ARTIFACT / f'{name}.txt').write_text('\n'.join(self.screen.display)+'\n')
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        os.close(self.master)


results = []
server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
targets = [('original', ORIGINAL), ('edualc', ROOT/'native/edualc'), ('launcher', ROOT/'bin/edualc-direct')]
if '--launcher-only' in sys.argv:
    targets = targets[-1:]
elif '--before-fix' in sys.argv:
    targets = targets[1:2]
for name, binary in targets:
    if '--before-fix' in sys.argv:
        if name == 'original':
            continue
        binary = Path(os.environ['EDUALC_BEFORE_FIX_APP_ROOT']).resolve(strict=True) / 'native/edualc'
    modes = ['switch'] if name == 'launcher' or '--switch-only' in sys.argv else ['sticky', 'healthy', 'switch']
    for mode in modes:
        sticky = mode == 'sticky'
        case = f'{name}-{mode}'
        if '--before-fix' in sys.argv:
            case += '-before-fix'
        print(case, flush=True)
        with tempfile.TemporaryDirectory(prefix='edualc-fullscreen-') as temporary, ExitStack() as cleanup:
            home = Path(temporary).resolve()
            cleanup.callback(stop_isolated_processes, home)
            work = home/'work'
            work.mkdir()
            (home/'.claude').mkdir()
            shared_settings = {'tui': 'default' if mode == 'switch' else 'fullscreen',
                'disableAllHooks': True, 'theme': 'dark'}
            if name in ('launcher', 'edualc'):
                (home/'.edualc').mkdir()
                (home/'.edualc/settings.json').write_text(json.dumps({'env':{'ANTHROPIC_API_KEY':KEY,'ANTHROPIC_CUSTOM_HEADERS':'anthropic-workspace-id: wrkspc_edualc_fixture'}}))
            if name == 'launcher':
                shared_settings['env'] = {'ANTHROPIC_API_KEY':'sk-shared-fixture-key',
                    'ANTHROPIC_AUTH_TOKEN':'shared-fixture-bearer', 'CLAUDE_CODE_OAUTH_TOKEN':'shared-fixture-oauth'}
            sdk_current = home/'.local/share/edualc/sdk/current'
            sdk_current.parent.mkdir(parents=True)
            sdk_current.symlink_to(SDK.parents[2], target_is_directory=True)
            (home/'.claude/settings.json').write_text(json.dumps(shared_settings))
            config = {'hasCompletedOnboarding': True, 'theme': 'dark',
                'customApiKeyResponses': {'approved': [KEY[-20:], 'sk-shared-fixture-key'[-20:]], 'rejected': []},
                'projects': {str(work): {'hasTrustDialogAccepted': True}}}
            if sticky:
                config['fullscreenAutoDisabled'] = {'version': MANIFEST['version'], 'at': int(time.time()*1000), 'strikes': 2}
            (home/'.claude.json').write_text(json.dumps(config))
            environment = {k:v for k,v in os.environ.items()
                if not k.startswith(('ANTHROPIC_', 'CLAUDE_', 'EDUALC_')) and k != 'BUN_OPTIONS'}
            environment.update({'HOME': str(home), 'ANTHROPIC_API_KEY': KEY,
                'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}',
                'ANTHROPIC_CUSTOM_HEADERS':'x-litellm-api-key: fixture-proxy-auth',
                'CLAUDE_SECURESTORAGE_CONFIG_DIR': str(home/'.edualc'),
                'EDUALC_SDK_PACKAGE': str(SDK), 'CLAUDE_CODE_MODEL_CATALOG': 'off',
                'DISABLE_AUTOUPDATER': '1', 'DISABLE_NON_ESSENTIAL_MODEL_CALLS': '1',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'TERM': 'xterm-256color',
                'HTTP_PROXY': '', 'HTTPS_PROXY': '', 'ALL_PROXY': '',
                'http_proxy': '', 'https_proxy': '', 'all_proxy': '', 'NO_PROXY': '*', 'no_proxy': '*'})
            if name == 'edualc':
                # 直接バイナリを試す場合も、自己再起動に必要な認証ファイルは正式なランチャーで準備する。
                subprocess.run([str(ROOT/'bin/edualc-direct'), '--version'], env=environment,
                               check=True, capture_output=True, timeout=30)
                environment['EDUALC_AUTH_SETTINGS_FILE'] = str(home/'.edualc/runtime-auth.json')
                bootstrap = binary.parent.parent/'bootstrap.mjs' if '--before-fix' in sys.argv else ROOT/'bootstrap.mjs'
                environment['BUN_OPTIONS'] = f'--preload={bootstrap}'
            terminal = Terminal(binary, environment, work)
            try:
                terminal.wait('Opus 5')
                terminal.drain(.3)
                alternate = b'\x1b[?1049h' in terminal.raw
                if mode == 'switch':
                    assert not alternate, (case, 'started fullscreen unexpectedly')
                    request_start = len(requests)
                    if name == 'launcher':
                        response_phase = 'BEFORE'
                        first_response = 'FULLSCREEN_RELAUNCH_SDK_OK_BEFORE'
                        terminal.send('Reply briefly before switching.\r')
                        terminal.wait(first_response)
                        terminal.drain(.6)
                        runtime_auth = home/'.edualc/runtime-auth.json'
                        assert runtime_auth.stat().st_mode & 0o777 == 0o600
                        assert json.loads(runtime_auth.read_text())['env']['ANTHROPIC_API_KEY'] == KEY
                        command_line = subprocess.run(['ps','-p',str(terminal.process.pid),'-o','args='],
                            check=True, text=True, capture_output=True).stdout
                        assert KEY not in command_line
                        assert str(runtime_auth) not in command_line
                    terminal.send('/tui fullscreen\r')
                    deadline = time.monotonic() + 30
                    while b'\x1b[?1049h' not in terminal.raw:
                        assert terminal.process.poll() is None, (case, terminal.process.returncode)
                        assert time.monotonic() < deadline, (case, '\n'.join(terminal.screen.display))
                        terminal.drain()
                    terminal.drain(1)
                    response_phase = 'AFTER'
                    expected_response = 'FULLSCREEN_RELAUNCH_SDK_OK_AFTER'
                    terminal.send('Reply briefly.\r')
                    if '--before-fix' in sys.argv:
                        terminal.wait('sdkRun')
                        assert not requests, 'The broken bridge unexpectedly reached the model fixture'
                        results.append({'case':case, 'alternate_screen_after_relaunch':True,
                            'reproduced_missing_sdk_registry':True, 'model_requests':len(requests)})
                        continue
                    terminal.wait(expected_response)
                    result = {'case':case, 'alternate_screen_after_relaunch':True,
                        'model_response_after_relaunch':True}
                    if name == 'launcher':
                        headers = auth_headers[request_start:]
                        assert len(headers)>=2
                        assert all(h['x-api-key']==KEY and h['authorization'] is None for h in headers), headers
                        assert all(h['workspace']=='wrkspc_edualc_fixture' and h['proxy_auth']=='fixture-proxy-auth' for h in headers), headers
                        command_line = subprocess.run(['ps','-p',str(terminal.process.pid),'-o','args='],
                            check=True, text=True, capture_output=True).stdout
                        assert KEY not in command_line
                        assert str(runtime_auth) not in command_line
                        assert runtime_auth.stat().st_mode & 0o777 == 0o600
                        result.update({'model_response_before_relaunch':True,
                            'private_api_key_only':True, 'authorization_header_absent':True,
                            'runtime_auth_mode':'0600', 'api_key_absent_from_process_arguments':True,
                            'workspace_header_and_existing_proxy_header_preserved':True,
                            'model_requests_checked':len(headers)})
                    results.append(result)
                    terminal.send('/exit\r')
                    deadline = time.monotonic()+10
                    while terminal.process.poll() is None and time.monotonic()<deadline:
                        terminal.drain(.1)
                    assert terminal.process.poll() == 0, (case, terminal.process.poll())
                    continue
                assert alternate is not sticky, (case, alternate)
                terminal.send('FULLSCREEN_INPUT_3179')
                terminal.wait('FULLSCREEN_INPUT_3179')
                terminal.send('\x15')
                terminal.drain(.2)
                fcntl.ioctl(terminal.master, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 95, 0, 0))
                terminal.screen.resize(35, 95)
                os.kill(terminal.process.pid, signal.SIGWINCH)
                terminal.drain(.4)
                terminal.send('/model\r')
                terminal.wait('Select model')
                terminal.send('\x1b')
                terminal.drain(.5)
                terminal.send('\x15')
                terminal.drain(.2)
                if not sticky:
                    terminal.drain(11)
                    saved = json.loads((home/'.claude.json').read_text())
                    assert str(terminal.process.pid) not in saved.get('fullscreenBootPending', {}), saved.get('fullscreenBootPending')
                    assert 'fullscreenBootStrikes' not in saved
                    assert 'fullscreenAutoDisabled' not in saved
                terminal.send('/exit\r')
                deadline = time.monotonic()+10
                while terminal.process.poll() is None and time.monotonic()<deadline:
                    terminal.drain(.1)
                assert terminal.process.poll() == 0, (case, terminal.process.poll())
                if alternate:
                    assert b'\x1b[?1049l' in terminal.raw
                results.append({'case': case, 'alternate_screen': alternate,
                    'typed_input': True, 'resize': True, 'model_picker': True,
                    'healthy_after_10_seconds': not sticky, 'clean_exit': True})
            finally:
                terminal.close(case)

result_name = 'result-before-fix.json' if '--before-fix' in sys.argv else 'result-launcher.json' if '--launcher-only' in sys.argv else 'result.json'
(ARTIFACT/result_name).write_text(json.dumps({'schema_version':1,
    'isolated_home':True, 'model_api':'localhost fixture only',
    'cases':results}, ensure_ascii=False, indent=2)+'\n')
print(json.dumps(results, ensure_ascii=False, indent=2))
