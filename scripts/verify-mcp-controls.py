# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Verify native MCP enable, disable and reconnect against the SDK connection."""
import http.server, threading, json, tempfile, subprocess, pathlib, os, pty, select, time, fcntl, termios, struct, signal
import pyte
from fixture_processes import stop_isolated_processes
ROOT=pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/'test/artifacts/mcp-controls'
ARTIFACTS.mkdir(parents=True,exist_ok=True)
APP=pathlib.Path(os.environ.get('EDUALC_APP_ROOT',ROOT))
ORIGINAL=pathlib.Path.home()/'.local/share/claude/versions/2.1.302'
SDK=(pathlib.Path.home()/'.local/share/edualc/sdk/current').resolve()
requests=[]
class API(http.server.BaseHTTPRequestHandler):

    def log_message(self, *a):
        pass

    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))))
        b['_fixture_sdk'] = 'agent-sdk/' in self.headers.get('user-agent', '')
        b['_fixture_private_key'] = self.headers.get('x-api-key') == 'sk-sdk-options-fixture'
        requests.append(b)
        (ARTIFACTS/'requests.json').write_text(json.dumps(requests,indent=2))
        names = [t.get('name') for t in b.get('tools', [])]
        messages=json.dumps(b.get('messages',[]))
        if 'count_tokens' in self.path:
            r = {'input_tokens': 20}
        else:
            current=next(m for m in reversed(b.get('messages',[])) if m.get('role')=='user').get('content',[])
            called=any(x.get('type')=='tool_result' for x in current) if isinstance(current,list) else False
            stage=max(['INITIAL','DISABLED','ENABLED','RECONNECTED'],key=lambda v:messages.rfind('MCP_'+v+'_628193'))
            marker='MCP_CONTROL_DONE_'+stage
            content=[{'type':'tool_use','id':'toolu_fixture_'+str(len(requests)),'name':'mcp__fixture__lookup','input':{}}] if 'mcp__fixture__lookup' in names and not called else [{'type':'text','text':marker}]
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

class Terminal:
    def __init__(self, command, home, env, name):
        self.master,slave=pty.openpty()
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',45,140,0,0))
        self.process=subprocess.Popen(command,cwd=home,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave)
        self.screen=pyte.Screen(140,45)
        self.stream=pyte.ByteStream(self.screen)
        self.raw=bytearray()
        self.name=name
    def drain(self,duration=.2):
        until=time.monotonic()+duration
        while time.monotonic()<until:
            if not select.select([self.master],[],[],.03)[0]:continue
            try:data=os.read(self.master,65536)
            except OSError:break
            if not data:break
            self.raw.extend(data)
            self.stream.feed(data)
        (ARTIFACTS/(self.name+'.ansi')).write_bytes(self.raw)
        (ARTIFACTS/(self.name+'.screen.txt')).write_text('\n'.join(self.screen.display))
    def send(self,text):os.write(self.master,text.encode())
    def wait(self,text,timeout=30):
        until=time.monotonic()+timeout
        while time.monotonic()<until:
            self.drain()
            if text in '\n'.join(self.screen.display) or text.encode() in self.raw:return
            if self.process.poll()is not None:break
        raise AssertionError((self.name,'Timed out waiting for '+text,'\n'.join(self.screen.display)))
    def close(self):
        if self.process.poll()is None:os.killpg(self.process.pid,signal.SIGKILL)
        self.process.wait(timeout=5)
        os.close(self.master)
results=[]
for name in ['original','edualc']:
    with tempfile.TemporaryDirectory(prefix='edualc-mcp-controls-')as temporary:
        home=pathlib.Path(temporary).resolve()
        (home/'.claude').mkdir();(home/'.edualc').mkdir()
        (home/'.claude/settings.json').write_text(json.dumps({'theme':'dark','disableAllHooks':False,'fastMode':False,'skipDangerousModePermissionPrompt':True}))
        (home/'.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'bypassPermissionsModeAccepted':True,'penguinModeOrgEnabled':True,'theme':'dark','projects':{str(home):{'hasTrustDialogAccepted':True}},'customApiKeyResponses':{'approved':['sk-sdk-options-fixture'[-20:]],'rejected':[]}}))
        (home/'.edualc/settings.json').write_text(json.dumps({'env':{'ANTHROPIC_API_KEY':'sk-sdk-options-fixture'}}))
        link=home/'.local/share/edualc/sdk/current';link.parent.mkdir(parents=True);link.symlink_to(SDK)
        env={k:v for k,v in os.environ.items()if not k.startswith(('ANTHROPIC_','CLAUDE_','EDUALC_','BUN_'))and k.lower()not in {'http_proxy','https_proxy','all_proxy','no_proxy'}}
        env.update(HOME=str(home),ANTHROPIC_BASE_URL=f'http://127.0.0.1:{api.server_port}',ANTHROPIC_API_KEY='sk-sdk-options-fixture',TERM='xterm-256color',DISABLE_AUTOUPDATER='1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',DISABLE_NON_ESSENTIAL_MODEL_CALLS='1',CLAUDE_CODE_MODEL_CATALOG='off',CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK='1',NO_PROXY='*',no_proxy='*')
        if name=='edualc':env.pop('ANTHROPIC_API_KEY');env['CLAUDE_CODE_OAUTH_TOKEN']='dummy-original-oauth';env['EDUALC_TRACE']='1'
        mcp=home/'mcp.py'; log=home/'mcp-log.jsonl'
        mcp.write_text("""import json,sys,os,pathlib
log=pathlib.Path(sys.argv[1])
def record(value):
 with log.open('a') as stream:stream.write(json.dumps({'pid':os.getpid(),**value})+'\\n')
record({'event':'start','sdk':'agent-sdk' in os.environ.get('CLAUDE_CODE_ENTRYPOINT','')})
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r:continue
 m=r.get('method')
 if m=='initialize':v={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
 elif m=='tools/list':v={'tools':[{'name':'lookup','description':'Fixture lookup','inputSchema':{'type':'object','properties':{}},'annotations':{'readOnlyHint':True}}]}
 elif m=='tools/call':record({'event':'call'});v={'content':[{'type':'text','text':'LOCAL_MCP_VALUE'}]}
 elif m in ('resources/list','prompts/list'):v={m.split('/')[0]:[]}
 else:v={}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':v}),flush=True)
""")
        config=json.dumps({'mcpServers':{'fixture':{'command':__import__('sys').executable,'args':[str(mcp),str(log)]}}})
        env['ENABLE_TOOL_SEARCH']='false'
        command=[str(ORIGINAL if name=='original' else APP/'bin/edualc-direct'),'--model','claude-opus-5','--dangerously-skip-permissions','--tools','Read','--strict-mcp-config','--mcp-config',config]
        def logs():return [json.loads(row) for row in log.read_text().splitlines()] if log.exists() else []
        def calls():return len([row for row in logs() if row['event']=='call'])
        def sdk_call_pid():return [row['pid'] for row in logs() if row['event']=='call'][-1]
        terminal=Terminal(command,home,env,name)
        try:
            terminal.wait('for agents');terminal.drain(.5)
            terminal.drain(2)
            start=len(requests)
            def ask(marker):
                terminal.send(marker+'\r')
                terminal.wait('MCP_CONTROL_DONE_'+marker.split('_')[1])
                terminal.drain(.7)
            ask('MCP_INITIAL_628193')
            assert calls()==1,(name,logs())
            terminal.send('/mcp disable fixture\r')
            terminal.wait('disabled')
            terminal.drain(.5)
            disabled_start=len(requests)
            ask('MCP_DISABLED_628193')
            assert calls()==1,(name,'Disabled MCP still executed',logs())
            assert all('mcp__fixture__lookup' not in [t.get('name') for t in b.get('tools',[])] for b in requests[disabled_start:]),(name,'Disabled MCP still exposed')
            terminal.send('/mcp enable fixture\r')
            terminal.wait('enabled')
            terminal.drain(.7)
            ask('MCP_ENABLED_628193')
            assert calls()==2,(name,'Enabled MCP did not execute',logs())
            enabled_pid=sdk_call_pid()
            terminal.send('/mcp reconnect fixture\r')
            terminal.wait('reconnected')
            terminal.drain(.7)
            ask('MCP_RECONNECTED_628193')
            assert calls()==3,(name,'Reconnected MCP did not execute',logs())
            after_pid=sdk_call_pid()
            assert after_pid!=enabled_pid,(name,'SDK MCP process was not reconnected',logs())
            scenario_requests=requests[start:]
            if name=='edualc':assert all(b['_fixture_sdk'] and b['_fixture_private_key'] for b in scenario_requests)
            results.append({'name':name,'mcp_calls':calls(),'disabled_schema_absent':True,'reconnected_process_changed':True,'requests':len(scenario_requests)})
            (ARTIFACTS/(name+'-mcp-log.json')).write_text(json.dumps(logs(),indent=2)+'\n')
        finally:
            terminal.close();stop_isolated_processes(home)
(ARTIFACTS/'result.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
api.shutdown()
