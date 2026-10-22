# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Exercise deferred ToolSearch and MCP execution through an isolated LiteLLM.

All provider calls terminate at localhost and use disposable credentials.
"""
import argparse
import fcntl
import pty
import select
import struct
import termios
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import pyte

from fixture_processes import stop_isolated_processes

ROOT = Path(__file__).resolve().parents[1]
PARSER = argparse.ArgumentParser(description=__doc__)
PARSER.add_argument('--litellm', type=Path, required=True, help='Existing LiteLLM executable used by the shared local proxy')
ARGS = PARSER.parse_args()
ARTIFACTS = ROOT / 'test/artifacts/tool-search'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
SDK = (Path.home() / '.local/share/edualc/sdk/current/node_modules/@anthropic-ai/claude-agent-sdk').resolve()
ORIGINAL = Path.home() / '.local/share/claude/versions/2.1.302'
TOOL = 'mcp__fixture__lookup_0'
SUCCESS = 'TOOL_SEARCH_ROUNDTRIP_OK_58319'
MCP_VALUE = 'MCP_EXECUTED_719285'
REQUESTS = []
API_REQUESTS = []


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        REQUESTS.append({'path': self.path, 'body': body, 'sdk': 'agent-sdk/' in self.headers.get('user-agent', '')})
        if 'count_tokens' in self.path:
            result = {'input_tokens': 30}
        else:
            messages = json.dumps(body.get('messages', []))
            if not any(t.get('name') == 'ToolSearch' for t in body.get('tools', [])):
                content = [{'type': 'text', 'text': 'Fixture helper response'}]
                reason = 'end_turn'
            elif MCP_VALUE in messages:
                content = [{'type': 'text', 'text': SUCCESS}]
                reason = 'end_turn'
            elif 'tool_reference' in messages:
                content = [{'type': 'tool_use', 'id': f'toolu_fixture_lookup_{len(REQUESTS)}', 'name': TOOL,
                            'input': {'q': 'fixture'}}]
                reason = 'tool_use'
            else:
                content = [{'type': 'tool_use', 'id': f'toolu_fixture_search_{len(REQUESTS)}', 'name': 'ToolSearch',
                            'input': {'query': 'select:' + TOOL, 'max_results': 1}}]
                reason = 'tool_use'
            result = {'id': f'msg_fixture_{len(REQUESTS)}', 'type': 'message', 'role': 'assistant',
                      'model': body.get('model'), 'content': content, 'stop_reason': reason,
                      'stop_sequence': None, 'usage': {'input_tokens': 30, 'output_tokens': 10}}
        data = json.dumps(result).encode()
        content_type = 'application/json'
        if body.get('stream') and 'content' in result:
            frames = [('message_start', {'type': 'message_start', 'message': {
                **result, 'content': [], 'stop_reason': None, 'usage': {'input_tokens': 30, 'output_tokens': 0}}})]
            for index, block in enumerate(result['content']):
                initial = {**block, 'input': {}} if block['type'] == 'tool_use' else {'type': 'text', 'text': ''}
                delta = {'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])} if block['type'] == 'tool_use' else {'type': 'text_delta', 'text': block['text']}
                frames.extend([
                    ('content_block_start', {'type': 'content_block_start', 'index': index, 'content_block': initial}),
                    ('content_block_delta', {'type': 'content_block_delta', 'index': index, 'delta': delta}),
                    ('content_block_stop', {'type': 'content_block_stop', 'index': index}),
                ])
            frames.extend([
                ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': result['stop_reason'], 'stop_sequence': None}, 'usage': {'output_tokens': 10}}),
                ('message_stop', {'type': 'message_stop'}),
            ])
            data = ''.join(f'event: {event}\ndata: {json.dumps(value)}\n\n' for event, value in frames).encode()
            content_type = 'text/event-stream'
        self.send_response(200)
        self.send_header('content-type', content_type)
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class ProxyRecorder(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        data = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        body = json.loads(data)
        API_REQUESTS.append({'path': self.path, 'body': body, 'sdk': 'agent-sdk/' in self.headers.get('user-agent', '')})
        headers = {name: value for name, value in self.headers.items() if name.lower() not in {'host', 'content-length'}}
        request = urllib.request.Request(self.server.upstream + self.path, data=data, headers=headers)
        with urllib.request.urlopen(request, timeout=20) as response:
            content = response.read()
            self.send_response(response.status)
            self.send_header('content-type', response.headers.get('content-type', 'application/json'))
            self.send_header('content-length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)


def clean_env(home):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('ANTHROPIC_', 'CLAUDE_', 'EDUALC_', 'BUN_', 'LITELLM_'))
           and key.lower() not in {'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'}}
    env.update(HOME=str(home), HTTP_PROXY='', HTTPS_PROXY='', ALL_PROXY='', NO_PROXY='*',
               http_proxy='', https_proxy='', all_proxy='', no_proxy='*',
               DISABLE_AUTOUPDATER='1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',
               DISABLE_NON_ESSENTIAL_MODEL_CALLS='1', LITELLM_LOCAL_MODEL_COST_MAP='True',
               PYTHONDONTWRITEBYTECODE='1')
    return env


provider = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=provider.serve_forever, daemon=True).start()
results = []
with tempfile.TemporaryDirectory(prefix='edualc-tool-search-') as temporary:
    home = Path(temporary).resolve()
    proxy = None
    recorder = None
    try:
        (home / '.claude').mkdir()
        (home / '.claude/settings.json').write_text(json.dumps({'env': {'ENABLE_TOOL_SEARCH': 'true'}, 'theme': 'dark', 'disableAllHooks': True}))
        (home / '.claude.json').write_text(json.dumps({'hasCompletedOnboarding': True,
            'theme': 'dark', 'projects': {str(home): {'hasTrustDialogAccepted': True}},
            'customApiKeyResponses': {'approved': ['tool-search-fixture'], 'rejected': []}}))
        mcp = home / 'mcp.py'
        mcp.write_text('''import sys,json,pathlib
log=pathlib.Path(sys.argv[1])
for line in sys.stdin:
 request=json.loads(line)
 if 'id' not in request:continue
 method=request.get('method')
 if method=='initialize':result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
 elif method=='tools/list':result={'tools':[{'name':'lookup_'+str(i),'description':'Look up fixture data. '+('Detailed fixture documentation. '*2000),'inputSchema':{'type':'object','properties':{'q':{'type':'string'}},'required':['q']},'annotations':{'readOnlyHint':True}} for i in range(3)]}
 elif method=='tools/call':
  with log.open('a') as output:output.write(json.dumps(request['params'])+'\\n')
  result={'content':[{'type':'text','text':'MCP_EXECUTED_719285'}]}
 elif method in ('resources/list','prompts/list'):result={method.split('/')[0]:[]}
 else:result={}
 print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
''')
        (home / '.edualc').mkdir()
        (home / '.edualc/settings.json').write_text(json.dumps({'env': {'ANTHROPIC_API_KEY': 'sk-tool-search-fixture'}}))
        sdk_link = home / '.local/share/edualc/sdk/current'
        sdk_link.parent.mkdir(parents=True)
        sdk_link.symlink_to((Path.home() / '.local/share/edualc/sdk/current').resolve())
        calls = home / 'mcp-calls.jsonl'
        config = {'fixture': {'command': sys.executable, 'args': [str(mcp), str(calls)]}}
        provider_base = f'http://127.0.0.1:{provider.server_port}'
        proxy_config = home / 'proxy.yaml'
        # JSON is a subset of YAML. No external endpoint or real key is reachable.
        proxy_config.write_text(json.dumps({'model_list': [{'model_name': 'claude-opus-5-5',
            'litellm_params': {'model': 'anthropic/claude-opus-5-5', 'api_base': provider_base,
                               'api_key': 'sk-local-provider-fixture'}}],
            'litellm_settings': {'drop_params': False, 'num_retries': 0},
            'general_settings': {'disable_spend_logs': True}}))
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            proxy_port = sock.getsockname()[1]
        proxy_env = clean_env(home)

        with (ARTIFACTS / 'proxy.log').open('w') as proxy_log:
            proxy_command = [str(ARGS.litellm)]
            proxy = subprocess.Popen([*proxy_command, '--config', str(proxy_config), '--host', '127.0.0.1', '--port', str(proxy_port)],
                                     env=proxy_env, cwd=home, stdout=proxy_log, stderr=subprocess.STDOUT)
            base = f'http://127.0.0.1:{proxy_port}'
            for _ in range(200):
                if proxy.poll() is not None:
                    raise AssertionError('Fixture LiteLLM failed to start; see proxy.log')
                try:
                    urllib.request.urlopen(base + '/health/liveliness', timeout=.5).close()
                    break
                except Exception:
                    time.sleep(.1)
            else:
                raise AssertionError('Fixture LiteLLM did not become ready')
            recorder = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ProxyRecorder)
            recorder.upstream = base
            threading.Thread(target=recorder.serve_forever, daemon=True).start()
            client_base = f'http://127.0.0.1:{recorder.server_port}'
            runner = home / 'sdk.mjs'
            runner.write_text(f'''import {{query}} from {json.dumps(str(SDK / 'sdk.mjs'))};
const q=query({{prompt:'Use the fixture lookup to answer.',options:{{model:'claude-opus-5-5',systemPrompt:{{type:'preset',preset:'claude_code'}},tools:['ToolSearch'],allowedTools:['{TOOL}'],strictMcpConfig:true,mcpServers:JSON.parse(process.env.FIXTURE_MCP),settingSources:['user'],pathToClaudeCodeExecutable:{json.dumps(str(SDK.parent / 'claude-agent-sdk-darwin-arm64/claude'))},env:process.env,maxTurns:5}}}});
for await(const message of q) console.log(JSON.stringify(message));
''')
            for name in ['original', 'sdk', 'edualc']:
                env = clean_env(home)
                env.update(ANTHROPIC_API_KEY='sk-tool-search-fixture', ANTHROPIC_BASE_URL=client_base,
                           CLAUDE_CODE_INLINE_TOOLS='0', FIXTURE_MCP=json.dumps(config), TERM='xterm-256color', CLAUDE_CODE_MODEL_CATALOG='off')
                if name == 'edualc':
                    env.pop('ANTHROPIC_API_KEY', None)
                    env['CLAUDE_CODE_OAUTH_TOKEN'] = 'original-oauth-fixture'
                command = ['node', str(runner)] if name == 'sdk' else [str(ORIGINAL if name == 'original' else (Path.home() / '.local/bin/edualc').resolve().parent / 'edualc-direct'), '-p',
                    'Use the fixture lookup to answer.', '--model', 'claude-opus-5-5', '--tools', 'ToolSearch',
                    '--allowedTools', TOOL, '--strict-mcp-config', '--mcp-config', json.dumps({'mcpServers': config}),
                    '--max-turns', '5', '--output-format', 'json']
                start = len(REQUESTS)
                api_start = len(API_REQUESTS)
                before = len(calls.read_text().splitlines()) if calls.exists() else 0
                if name == 'edualc':
                    command = [str((Path.home() / '.local/bin/edualc').resolve().parent / 'edualc-direct'),
                               '--model', 'claude-opus-5-5', '--permission-mode', 'default', '--tools', 'ToolSearch', '--allowedTools', TOOL,
                               '--strict-mcp-config', '--mcp-config', json.dumps({'mcpServers': config})]
                    master, slave = pty.openpty()
                    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 130, 0, 0))
                    terminal = subprocess.Popen(command, env=env, cwd=home, stdin=slave, stdout=slave, stderr=slave)
                    os.close(slave)
                    raw = bytearray()
                    screen = pyte.Screen(130,45)
                    stream = pyte.ByteStream(screen)
                    sent = False
                    approved = False
                    deadline = time.monotonic() + 45
                    while time.monotonic() < deadline:
                        if select.select([master], [], [], .1)[0]:
                            try:
                                data = os.read(master, 65536)
                                raw.extend(data)
                                stream.feed(data)
                                (ARTIFACTS / 'edualc-live.ansi').write_bytes(raw)
                            except OSError:
                                break
                        if 'Choose the text style' in '\n'.join(screen.display):
                            os.write(master, b'\r')
                        if 'Opus' in '\n'.join(screen.display) and not sent:
                            time.sleep(.5)
                            os.write(master, b'Use the fixture lookup to answer.\r')
                            sent = True
                        if 'Do you want to proceed?' in '\n'.join(screen.display) and not approved:
                            time.sleep(.5)
                            os.write(master, b'\r')
                            approved = True
                        if SUCCESS in '\n'.join(screen.display):
                            break
                    os.write(master, b'\x03\x03')
                    try:
                        terminal.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        terminal.kill()
                        terminal.wait(timeout=3)
                    os.close(master)
                    execution = subprocess.CompletedProcess(command, 0, '\n'.join(screen.display), '')
                else:
                    execution = subprocess.run(command, env=env, cwd=home, text=True, capture_output=True, timeout=45)
                (ARTIFACTS / f'{name}.stdout').write_text(execution.stdout)
                (ARTIFACTS / f'{name}.stderr').write_text(execution.stderr)
                requests = [r['body'] for r in REQUESTS[start:] if r['path'].split('?')[0].endswith('/messages') and any(t.get('name') == 'ToolSearch' for t in r['body'].get('tools', []))]
                (ARTIFACTS / f'{name}-provider.json').write_text(json.dumps(requests, indent=2))
                after = len(calls.read_text().splitlines()) if calls.exists() else 0
                if name == 'edualc':
                    assert all(r['sdk'] for r in API_REQUESTS[api_start:] if r['path'].split('?')[0].endswith('/messages')), 'edualc model request bypassed SDK'
                assert execution.returncode == 0, (name, execution.returncode, execution.stderr[-600:])
                assert SUCCESS in execution.stdout, (name, 'final response missing')
                assert after == before + 1, (name, 'MCP not invoked exactly once')
                assert len(requests) == 3, (name, 'expected search, MCP call, final response', len(requests))
                initial_tools = [t['name'] for t in requests[0].get('tools', [])]
                assert 'ToolSearch' in initial_tools and not any(t.startswith('mcp__') for t in initial_tools), (name, 'MCP schemas were not deferred')
                assert 'tool_reference' in json.dumps(requests[1]['messages']), (name, 'tool reference lost in proxy')
                assert any(t['name'] == TOOL for t in requests[1]['tools']), (name, 'selected MCP schema missing')
                assert MCP_VALUE in json.dumps(requests[2]['messages']), (name, 'MCP result lost in proxy')
                result = {'runtime': name, 'provider_requests': len(requests), 'initial_tools': initial_tools, 'sdk_model_requests': all(r['sdk'] for r in API_REQUESTS[api_start:] if r['path'].split('?')[0].endswith('/messages')),
                          'selected_tool_schema_reached_provider': True, 'tool_reference_preserved': True,
                          'mcp_calls': after - before, 'final_response': SUCCESS}
                results.append(result)
                print(json.dumps(result), flush=True)
    finally:
        if proxy is not None:
            proxy.terminate()
            try:
                proxy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proxy.kill()
                proxy.wait()
        stop_isolated_processes(home)
        provider.shutdown()
        if recorder is not None:
            recorder.shutdown()
(ARTIFACTS / 'result.json').write_text(json.dumps(results, indent=2) + '\n')
