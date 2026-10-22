"""Verify explicit MCP deny rules on both original Claude Code and edualc.

All model and MCP requests use disposable credentials and localhost fixtures.
"""
import argparse
import http.server, threading, json, tempfile, subprocess, pathlib, os, pty, select, time, fcntl, termios, struct, signal, sys
from fixture_processes import stop_isolated_processes
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--expect-deny-leak', action='store_true', help='Record the known pre-fix failure instead of requiring protection')
cli = parser.parse_args()
ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test/artifacts/mcp-permissions'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
APP = pathlib.Path(os.environ['EDUALC_APP_ROOT']) if 'EDUALC_APP_ROOT' in os.environ else (pathlib.Path.home() / '.local/bin/edualc').resolve().parent.parent
EDUALC = APP / 'bin/edualc-direct'
ORIGINAL = pathlib.Path.home() / '.local/share/claude/versions/2.1.302'
real_sdk = (pathlib.Path.home() / '.local/share/edualc/sdk/current').resolve()
TOOL = 'mcp__fixture__lookup'
requests = []

class API(http.server.BaseHTTPRequestHandler):

    def log_message(self, *a):
        pass

    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))))
        requests.append(b)
        names = [t.get('name') for t in b.get('tools', [])]
        if 'count_tokens' in self.path:
            r = {'input_tokens': 20}
        else:
            called = any((x.get('type') == 'tool_result' for m in b.get('messages', []) for x in (m.get('content', []) if isinstance(m.get('content'), list) else [])))
            content = [{'type': 'tool_use', 'id': 'toolu_deny_audit', 'name': TOOL, 'input': {}}] if TOOL in names and (not called) else [{'type': 'text', 'text': 'AUDIT_FINAL_73829'}]
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
with tempfile.TemporaryDirectory(prefix='edualc-deny-audit-') as d:
    h = pathlib.Path(d).resolve()
    (h / '.claude').mkdir()
    (h / '.edualc').mkdir()
    (h / '.claude/settings.json').write_text(json.dumps({'theme': 'dark', 'disableAllHooks': True, 'skipDangerousModePermissionPrompt': True, 'env': {'ENABLE_TOOL_SEARCH': 'false'}}))
    (h / '.claude.json').write_text(json.dumps({'hasCompletedOnboarding': True, 'bypassPermissionsModeAccepted': True, 'theme': 'dark', 'projects': {str(h): {'hasTrustDialogAccepted': True}}, 'customApiKeyResponses': {'approved': ['deny-audit-fixture'], 'rejected': []}}))
    (h / '.edualc/settings.json').write_text(json.dumps({'env': {'ANTHROPIC_API_KEY': 'sk-deny-audit-fixture'}}))
    link = h / '.local/share/edualc/sdk/current'
    link.parent.mkdir(parents=True)
    link.symlink_to(real_sdk)
    mcp = h / 'mcp.py'
    log = h / 'calls'
    mcp.write_text("import json,sys,pathlib\nfor line in sys.stdin:\n r=json.loads(line)\n if'id'not in r:continue\n m=r.get('method')\n if m=='initialize':v={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}\n elif m=='tools/list':v={'tools':[{'name':'lookup','description':'Fixture lookup','inputSchema':{'type':'object','properties':{}},'annotations':{'readOnlyHint':True}}]}\n elif m=='tools/call':\n  pathlib.Path(sys.argv[1]).write_text('EXECUTED');v={'content':[{'type':'text','text':'LOCAL_MCP_VALUE'}]}\n elif m in('resources/list','prompts/list'):v={m.split('/')[0]:[]}\n else:v={}\n print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':v}),flush=True)\n")
    config = json.dumps({'mcpServers': {'fixture': {'command': sys.executable, 'args': [str(mcp), str(log)]}}})
    base = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'CLAUDE_', 'EDUALC_', 'BUN_')) and k.lower() not in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')}
    base.update(HOME=str(h), ANTHROPIC_BASE_URL=f'http://127.0.0.1:{api.server_port}', ANTHROPIC_API_KEY='sk-deny-audit-fixture', TERM='xterm-256color', DISABLE_AUTOUPDATER='1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_NON_ESSENTIAL_MODEL_CALLS='1', CLAUDE_CODE_MODEL_CATALOG='off', NO_PROXY='*', no_proxy='*')
    args = ['--model', 'claude-opus-5', '--dangerously-skip-permissions', '--tools', 'Read', '--disallowedTools', TOOL, '--strict-mcp-config', '--mcp-config', config]
    results = []
    for name in ('original', 'edualc'):
        if log.exists():
            log.unlink()
        start = len(requests)
        env = base.copy()
        if name == 'original':
            p = subprocess.run([str(ORIGINAL), '-p', 'Audit forbidden MCP', '--output-format', 'json', *args], cwd=h, env=env, capture_output=True, timeout=45)
            tail = p.stdout.decode()[-800:]
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
                        os.write(master, b'Audit forbidden MCP\r')
                        sent = True
                    if b'AUDIT_FINAL_73829' in raw:
                        break
                    if p.poll() is not None:
                        break
            finally:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait(timeout=5)
                os.close(master)
            tail = raw.decode(errors='replace')[-900:]
            rc = p.returncode
        assert 'AUDIT_FINAL_73829' in tail, (name, 'The fixture did not complete')
        results.append({'name': name, 'mcp_executed': log.exists(), 'mcp_in_schema': any((TOOL in [t.get('name') for t in b.get('tools', [])] for b in requests[start:])), 'requests': len(requests) - start})
        stop_isolated_processes(h)
    assert not results[0]['mcp_executed'] and (not results[0]['mcp_in_schema']), results
    assert results[1]['mcp_executed'] == cli.expect_deny_leak, results
    assert results[1]['mcp_in_schema'] == cli.expect_deny_leak, results
    report = {'scenario': 'Explicit MCP deny remains effective in bypass mode', 'expected_pre_fix_failure': cli.expect_deny_leak, 'results': results}
    (ARTIFACTS / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
api.shutdown()
