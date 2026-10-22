"""Verify CLI-defined agents execute through the original TUI and the SDK bridge.

All model and MCP requests use disposable credentials and localhost fixtures.
"""
import argparse
import http.server, threading, json, tempfile, subprocess, pathlib, os, pty, select, time, fcntl, termios, struct, signal, sys
from fixture_processes import stop_isolated_processes
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--expect-missing-agent', action='store_true')
cli = parser.parse_args()
ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test/artifacts/sdk-options'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
APP = pathlib.Path(os.environ['EDUALC_APP_ROOT']) if 'EDUALC_APP_ROOT' in os.environ else (pathlib.Path.home() / '.local/bin/edualc').resolve().parent.parent
EDUALC = APP / 'bin/edualc-direct'
ORIGINAL = pathlib.Path.home() / '.local/share/claude/versions/2.1.302'
real_sdk = (pathlib.Path.home() / '.local/share/edualc/sdk/current').resolve()
AGENT='fixture-agent'
AGENT_MARKER='SDK_AGENT_SYSTEM_628193'
DEFINITION={AGENT:{'description':'Fixture agent for the option transfer test','prompt':AGENT_MARKER,'model':'inherit','tools':['Read'],'memory':'project'}}
requests = []

class API(http.server.BaseHTTPRequestHandler):

    def log_message(self, *a):
        pass

    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))))
        b['_fixture_sdk'] = 'agent-sdk/' in self.headers.get('user-agent', '')
        b['_fixture_private_key'] = self.headers.get('x-api-key') == 'sk-deny-audit-fixture'
        requests.append(b)
        (ARTIFACTS/'requests.json').write_text(json.dumps(requests,indent=2))
        names = [t.get('name') for t in b.get('tools', [])]
        system=json.dumps(b.get('system',[]))
        messages=json.dumps(b.get('messages',[]))
        if 'count_tokens' in self.path:
            r = {'input_tokens': 20}
        else:
            if AGENT_MARKER in system:
                content=[{'type':'text','text':'AGENT_CHILD_RESULT_29163'}]
            elif 'Agent' in names and 'AGENT_CHILD_RESULT_29163' not in messages and AGENT in json.dumps(b):
                content=[{'type':'tool_use','id':'toolu_options_agent','name':'Agent','input':{'description':'Check fixture','subagent_type':AGENT,'prompt':'Run the isolated fixture task.','run_in_background':False}}]
            elif 'Agent' in names and 'AGENT_CHILD_RESULT_29163' not in messages:
                content=[{'type':'text','text':'AGENT_MISSING_73829'}]
            else:
                content=[{'type':'text','text':'AGENT_SCENARIO_DONE_73829'}]
            r = {'id': 'msg_audit_' + str(len(requests)), 'type': 'message', 'role': 'assistant', 'model': b.get('model'), 'content': content, 'stop_reason': 'tool_use' if content[0]['type'] == 'tool_use' else 'end_turn', 'stop_sequence': None, 'usage': {'input_tokens': 20, 'output_tokens': 10}}
        data = json.dumps(r).encode()
        ct = 'application/json'
        if b.get('stream') and 'content' in r:
            frames = [('message_start', {'type': 'message_start', 'message': {**r, 'content': [], 'stop_reason': None, 'usage': {'input_tokens': 20, 'output_tokens': 0}}})]
            for i, x in enumerate(r['content']):
                frames += [('content_block_start', {'type': 'content_block_start', 'index': i, 'content_block': {**x, 'input': {}} if x['type'] == 'tool_use' else {'type': 'text', 'text': ''}}), ('content_block_delta', {'type': 'content_block_delta', 'index': i, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(x['input'])} if x['type'] == 'tool_use' else {'type': 'text_delta', 'text': x['text']}}), ('content_block_stop', {'type': 'content_block_stop', 'index': i})]
            frames += [('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': r['stop_reason'], 'stop_sequence': None}, 'usage': {'output_tokens': 10}}), ('message_stop', {'type': 'message_stop'})]
            data = ''.join((f'event: {e}\ndata: {json.dumps(v)}\n\n' for e, v in frames)).encode()
            ct = 'text/event-stream'
        self.send_response(200)
        self.send_header('content-type', ct)
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
api = http.server.ThreadingHTTPServer(('127.0.0.1', 0), API)
threading.Thread(target=api.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='edualc-sdk-options-') as d:
    h = pathlib.Path(d).resolve()
    (h / '.claude').mkdir()
    (h / '.edualc').mkdir()
    (h / '.claude/settings.json').write_text(json.dumps({'theme': 'dark', 'disableAllHooks': True, 'skipDangerousModePermissionPrompt': True, 'env': {'ENABLE_TOOL_SEARCH': 'false'}}))
    (h / '.claude.json').write_text(json.dumps({'hasCompletedOnboarding': True, 'bypassPermissionsModeAccepted': True, 'theme': 'dark', 'projects': {str(h): {'hasTrustDialogAccepted': True}}, 'customApiKeyResponses': {'approved': ['deny-audit-fixture'], 'rejected': []}}))
    (h / '.edualc/settings.json').write_text(json.dumps({'env': {'ANTHROPIC_API_KEY': 'sk-deny-audit-fixture'}}))
    link = h / '.local/share/edualc/sdk/current'
    link.parent.mkdir(parents=True)
    link.symlink_to(real_sdk)
    base = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'CLAUDE_', 'EDUALC_', 'BUN_')) and k.lower() not in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')}
    base.update(HOME=str(h), ANTHROPIC_BASE_URL=f'http://127.0.0.1:{api.server_port}', ANTHROPIC_API_KEY='sk-deny-audit-fixture', TERM='xterm-256color', DISABLE_AUTOUPDATER='1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_NON_ESSENTIAL_MODEL_CALLS='1', CLAUDE_CODE_MODEL_CATALOG='off', NO_PROXY='*', no_proxy='*')
    args=['--model','claude-opus-5','--dangerously-skip-permissions','--tools','Agent,Read','--agents',json.dumps(DEFINITION),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}']
    results = []
    for name in ('original', 'edualc'):
        start = len(requests)
        env = base.copy()
        if name == 'original':
            p = subprocess.run([str(ORIGINAL), '-p', 'Run the fixture agent now.', '--output-format', 'json', *args], cwd=h, env=env, capture_output=True, timeout=45)
            tail = p.stdout.decode(); (ARTIFACTS/'original-output.txt').write_text(tail+p.stderr.decode())
            rc = p.returncode
        else:
            env.pop('ANTHROPIC_API_KEY')
            env['CLAUDE_CODE_OAUTH_TOKEN'] = 'dummy-original-oauth'
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
            p = subprocess.Popen([str(EDUALC), *args], cwd=h, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave)
            raw = b''
            sent = False
            deadline = time.monotonic() + 45
            try:
                while time.monotonic() < deadline:
                    if select.select([master], [], [], 0.15)[0]:
                        try:
                            raw += os.read(master, 65536)
                            (ARTIFACTS / 'edualc.ansi').write_bytes(raw)
                        except OSError:
                            break
                    if b'Choose the text style' in raw[-20000:]:
                        os.write(master, b'\r')
                        time.sleep(0.2)
                    if not sent and ('❯'.encode() in raw or b'What would you like' in raw):
                        os.write(master, b'Run the fixture agent now.\r')
                        sent = True
                    if b'AGENT_SCENARIO_DONE_73829' in raw or b'AGENT_MISSING_73829' in raw:
                        break
                    if p.poll() is not None:
                        break
            finally:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait(timeout=5)
                os.close(master)
            tail = raw.decode(errors='replace')
            rc = p.returncode
        child_requests=[b for b in requests[start:] if AGENT_MARKER in json.dumps(b.get('system',[]))]
        if name == 'edualc':
            assert all(b['_fixture_sdk'] and b['_fixture_private_key'] for b in requests[start:]), 'Generation bypassed the private SDK path'
        missing=name=='edualc' and cli.expect_missing_agent
        assert bool(child_requests) != missing, (name, 'CLI agent execution mismatch')
        if child_requests:
            assert all(json.dumps(b.get('system',[])).count(AGENT_MARKER)==1 for b in child_requests)
            assert all(set(t.get('name') for t in b.get('tools',[]))=={'Read'} for b in child_requests), 'Agent tools widened'
        results.append({'name':name,'child_requests':len(child_requests),'agent_marker_once':bool(child_requests),'child_tools':[t.get('name') for t in child_requests[0].get('tools',[])] if child_requests else []})
        stop_isolated_processes(h)
    report={'scenario':'CLI agent execution with native launch definitions, memory and tool restrictions','expected_pre_fix_failure':cli.expect_missing_agent,'results':results}
    (ARTIFACTS/'agents-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))
api.shutdown()
