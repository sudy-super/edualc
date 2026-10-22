# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Verify goal Stop checks and memory pause through native TUI commands and the SDK."""
import http.server, threading, json, tempfile, subprocess, pathlib, os, pty, select, time, fcntl, termios, struct, signal
import pyte
from fixture_processes import stop_isolated_processes
ROOT=pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/'test/artifacts/goal-memory'
ARTIFACTS.mkdir(parents=True,exist_ok=True)
APP=pathlib.Path(os.environ.get('EDUALC_APP_ROOT',ROOT))
ORIGINAL=pathlib.Path.home()/'.local/share/claude/versions/2.1.302'
SDK=(pathlib.Path.home()/'.local/share/edualc/sdk/current').resolve()
requests=[]
clear_checks=0
clear_hook_release=threading.Event()
class API(http.server.BaseHTTPRequestHandler):

    def log_message(self, *a):
        pass

    def do_POST(self):
        global clear_checks
        b = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))))
        b['_fixture_sdk'] = 'agent-sdk/' in self.headers.get('user-agent', '')
        b['_fixture_private_key'] = self.headers.get('x-api-key') == 'sk-sdk-options-fixture'
        requests.append(b)
        (ARTIFACTS/'requests.json').write_text(json.dumps(requests,indent=2))
        names = [t.get('name') for t in b.get('tools', [])]
        system=json.dumps(b.get('system',[]))
        messages=json.dumps(b.get('messages',[]))
        if 'count_tokens' in self.path:
            r = {'input_tokens': 20}
        else:
            marker='GOAL_MAIN_ANSWER_628193'
            if 'AFTER_GOAL_CLEAR_85192' in messages:
                marker='GOAL_AFTER_CLEAR_85192'
            if not names and 'GOAL_CLEAR_CONDITION_62814' in messages:
                clear_checks+=1
                if clear_checks>1:clear_hook_release.wait(8)
                marker='{"ok":false,"reason":"GOAL_NOT_MET_62814"}'
            elif not names and 'GOAL_CONDITION_17483' in messages:
                marker='{"ok":true}'
            content=[{'type':'text','text':marker}]
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
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Escape cancels an in-flight Stop check.
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
            if text in '\n'.join(self.screen.display):return
            if self.process.poll()is not None:break
        raise AssertionError((self.name,'Timed out waiting for '+text,'\n'.join(self.screen.display)))
    def close(self):
        if self.process.poll()is None:os.killpg(self.process.pid,signal.SIGKILL)
        self.process.wait(timeout=5)
        os.close(self.master)
results=[]
for name in (['sdk'] if os.environ.get('EDUALC_GOAL_SDK_ONLY')=='1' else ['original','edualc']):
    with tempfile.TemporaryDirectory(prefix='edualc-fast-options-')as temporary:
        home=pathlib.Path(temporary).resolve()
        (home/'.claude').mkdir();(home/'.edualc').mkdir()
        (home/'.claude/settings.json').write_text(json.dumps({'theme':'dark','disableAllHooks':False,'fastMode':False,'skipDangerousModePermissionPrompt':True}))
        (home/'.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'bypassPermissionsModeAccepted':True,'penguinModeOrgEnabled':True,'theme':'dark','projects':{str(home):{'hasTrustDialogAccepted':True}},'customApiKeyResponses':{'approved':['sk-sdk-options-fixture'[-20:]],'rejected':[]}}))
        (home/'.edualc/settings.json').write_text(json.dumps({'env':{'ANTHROPIC_API_KEY':'sk-sdk-options-fixture'}}))
        link=home/'.local/share/edualc/sdk/current';link.parent.mkdir(parents=True);link.symlink_to(SDK)
        env={k:v for k,v in os.environ.items()if not k.startswith(('ANTHROPIC_','CLAUDE_','EDUALC_','BUN_'))and k.lower()not in {'http_proxy','https_proxy','all_proxy','no_proxy'}}
        env.update(HOME=str(home),ANTHROPIC_BASE_URL=f'http://127.0.0.1:{api.server_port}',ANTHROPIC_API_KEY='sk-sdk-options-fixture',TERM='xterm-256color',DISABLE_AUTOUPDATER='1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',DISABLE_NON_ESSENTIAL_MODEL_CALLS='1',CLAUDE_CODE_MODEL_CATALOG='off',CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK='1',NO_PROXY='*',no_proxy='*')
        if name=='edualc':env.pop('ANTHROPIC_API_KEY');env['CLAUDE_CODE_OAUTH_TOKEN']='dummy-original-oauth';env['EDUALC_TRACE']='1'
        command=[str(ORIGINAL if name=='original' else APP/'bin/edualc-direct'),'--model','claude-opus-5','--tools','Read','--strict-mcp-config','--mcp-config','{"mcpServers":{}}']
        if name=='sdk':
            runner=home/'sdk-goal.mjs'
            runner.write_text('import {query} from '+json.dumps(str(SDK/'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'))+';\n'+
                'async function* input(){yield {type:"user",message:{role:"user",content:'+json.dumps(os.environ.get('EDUALC_SDK_TEST_COMMAND','/goal GOAL_CONDITION_17483'))+'},parent_tool_use_id:null};}\n'+
                'const q=query({prompt:input(),options:{model:"claude-opus-5",tools:["Read"],includePartialMessages:true,settingSources:["user"],strictMcpConfig:true,mcpServers:{},persistSession:false,pathToClaudeCodeExecutable:'+json.dumps(str(SDK/'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'))+'}});\n'+
                'for await(const event of q){console.log(JSON.stringify(event));if(event.type==="result"){q.close();break;}}\n')
            output=subprocess.run(['node',str(runner)],cwd=home,env=env,capture_output=True,text=True,timeout=30)
            (ARTIFACTS/('sdk-memory-wire.jsonl' if os.environ.get('EDUALC_SDK_TEST_COMMAND') else 'sdk-wire.jsonl')).write_text(output.stdout)
            assert output.returncode==0,output.stderr
            wire=[json.loads(line)for line in output.stdout.splitlines()if line.startswith('{')]
            print([(row.get('type'),row.get('subtype'))for row in wire])
            continue
        terminal=Terminal(command,home,env,name)
        try:
            terminal.wait('for agents');terminal.drain(.5)
            start=len(requests)
            terminal.send('/goal GOAL_CONDITION_17483\r')
            terminal.wait('MAIN_ANSWER_628193')
            terminal.drain(2)
            print(name,'goal generation returned',flush=True)
            terminal.send('/goal\r')
            terminal.drain(1)
            (ARTIFACTS/(name+'-goal-status.txt')).write_text('\n'.join(terminal.screen.display))
            terminal.send('\x1b')
            terminal.drain(.5)
            assert any(not b.get('tools') and 'GOAL_CONDITION_17483' in json.dumps(b.get('messages',[])) for b in requests[start:]),(name,'Goal Stop check did not reach API')
            status=(ARTIFACTS/(name+'-goal-status.txt')).read_text()
            assert 'Goal achieved' in status and 'Goal active' not in status,(name,'Goal did not auto-clear in the native UI')
            clear_checks=0;clear_hook_release.clear()
            terminal.send('/goal GOAL_CLEAR_CONDITION_62814\r')
            deadline=time.monotonic()+20
            while clear_checks<2 and time.monotonic()<deadline:terminal.drain(.1)
            assert clear_checks>=2,(name,'Goal did not block stopping')
            terminal.send('\x1b')
            terminal.drain(.4);clear_hook_release.set();terminal.drain(1)
            terminal.send('/goal clear\r')
            terminal.wait('Goal cleared: GOAL_CLEAR_CONDITION_62814')
            terminal.drain(1)
            before_clear=len(requests)
            terminal.send('AFTER_GOAL_CLEAR_85192\r')
            terminal.wait('AFTER_CLEAR_85192')
            terminal.drain(.7)
            assert not any(not b.get('tools') and 'GOAL_CLEAR_CONDITION_62814' in json.dumps(b.get('messages',[])) for b in requests[before_clear:]),(name,'Stop hook still ran after /goal clear')
            scenario_requests=requests[start:]
            if name=='edualc':
                assert all(b['_fixture_sdk'] and b['_fixture_private_key'] for b in scenario_requests), 'A goal request bypassed the private SDK credentials'
            results.append({'name':name,'requests':len(scenario_requests),'unmet_stop_checks':clear_checks,
                            'auto_cleared':True,'manual_clear_removed_stop_hook':True,
                            'private_sdk_requests':name=='edualc'})
        finally:
            clear_hook_release.set();terminal.close();stop_isolated_processes(home)
(ARTIFACTS/'result.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
api.shutdown()
