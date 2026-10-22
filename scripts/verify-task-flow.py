# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Verify SDK background Bash tasks in the original task list and stop controls."""
import os,tempfile,json,pathlib,subprocess,threading,http.server,pty,fcntl,termios,struct,select,time,signal,re
from fixture_processes import stop_isolated_processes
import pyte
ROOT=pathlib.Path(os.environ.get("EDUALC_APP_ROOT", pathlib.Path(__file__).resolve().parents[1]))
ARTIFACTS=pathlib.Path(__file__).resolve().parents[1]/"test/artifacts/sdk-tasks"
ARTIFACTS.mkdir(parents=True,exist_ok=True)
KIND=os.environ.get("EDUALC_TASK_KIND","bash")
ARTIFACTS=ARTIFACTS/KIND
if os.environ.get('EDUALC_VERIFY_ORIGINAL')=='1':ARTIFACTS=ARTIFACTS/'original'
if os.environ.get('EDUALC_TASK_LABEL'):ARTIFACTS=ARTIFACTS/os.environ['EDUALC_TASK_LABEL']
ARTIFACTS.mkdir(parents=True,exist_ok=True)
REQUESTS=[]
AUTO_READY=threading.Event()
AUTO_RELEASE=threading.Event()
SECOND_READY=threading.Event()
SECOND_RELEASE=threading.Event()
CASE="stop"
class API(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  b=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  REQUESTS.append({'path':self.path,'body':b,'sdk':'agent-sdk/' in self.headers.get('user-agent','')})
  (ARTIFACTS/'inflight-requests.json').write_text(json.dumps(REQUESTS,ensure_ascii=False,indent=2))
  if 'count_tokens' in self.path:r={'input_tokens':10}
  else:
   main=any(tool.get('name') in ['Bash','Agent','mcp__fixture__slow'] for tool in b.get('tools',[]))
   overlap=main and 'USER_OVERLAP_834915' in json.dumps(b.get('messages',[]))
   complete=main and '<task-notification>' in json.dumps(b.get('messages',[])) and '<status>completed</status>' in json.dumps(b.get('messages',[]))
   if CASE=='race' and complete and not overlap:
    AUTO_READY.set()
    assert AUTO_RELEASE.wait(20), 'Race fixture auto-response was not released'
   if CASE=='race' and overlap:
    SECOND_READY.set()
    assert SECOND_RELEASE.wait(20), 'Race fixture user response was not released'
   done='tool_result' in json.dumps(b.get('messages',[]))
   child=any('CHILD_AGENT_TASK_587319' in str(block.get('text','')) for message in b.get('messages',[]) if message.get('role')=='user' for block in message.get('content',[]) if isinstance(block,dict))
   c=[{'type':'text','text':'SDK_COMPLETION_PROCESSED_34918' if '<task-notification>' in json.dumps(b.get('messages',[])) and '<status>completed</status>' in json.dumps(b.get('messages',[])) else 'SDK_BACKGROUND_READY_39481'}] if done else [{'type':'tool_use','id':'toolu_background','name':'Bash','input':{'command':worker_command,'description':'SDK_BACKGROUND_WORKER_782194','run_in_background':True}}]
   if KIND=='mcp' and not done:c=[{'type':'tool_use','id':'toolu_background_mcp','name':'mcp__fixture__slow','input':{}}]
   if KIND=='agent' and not child and not done:c=[{'type':'tool_use','id':'toolu_background_agent','name':'Agent','input':{'subagent_type':'general-purpose','description':'SDK_BACKGROUND_AGENT_58271','prompt':'CHILD_AGENT_TASK_587319 Run the fixture worker as a foreground Bash command.','run_in_background':True}}]
   elif KIND=='agent' and child and not done:c[0]['input']['run_in_background']=False
   if overlap:c=[{'type':'text','text':'SDK_SECOND_USER_835910'}]
   if CASE in ('keyboard','keyboard_complete','foreground') and not done and c[0]['type']=='tool_use' and c[0]['name'] in ('Bash','Agent'):c[0]['input']['run_in_background']=False
   if CASE=='parallel' and KIND=='agent' and not child and not done:
    c=[{**c[0],'id':f'toolu_parallel_{index}','input':{**c[0]['input'],'description':f'Parallel fixture {index}'}} for index in range(3)]
   if CASE=='parallel' and complete:
    ids=set(re.findall(r'<task-id>(.*?)</task-id>',json.dumps(b.get('messages',[]))))
    c=[{'type':'text','text':'SDK_COMPLETION_PROCESSED_34918' if len(ids)==3 else 'SDK_PARTIAL_COMPLETION'}]
   if not main:c=[{'type':'text','text':'Fixture background task'}];done=True
   r={'id':f'msg_fixture_{len(REQUESTS)}','type':'message','role':'assistant','model':b['model'],'content':c,'stop_reason':'end_turn' if done else 'tool_use','stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':10}}
  d=json.dumps(r).encode();ct='application/json'
  if b.get('stream') and 'content' in r:
   frames=[('message_start',{'type':'message_start','message':{**r,'content':[],'stop_reason':None}})]
   for i,block in enumerate(r['content']):
    tool=block['type']=='tool_use';initial={**block,'input':{}} if tool else {'type':'text','text':''};delta={'type':'input_json_delta','partial_json':json.dumps(block['input'])} if tool else {'type':'text_delta','text':block['text']}
    frames += [('content_block_start',{'type':'content_block_start','index':i,'content_block':initial}),('content_block_delta',{'type':'content_block_delta','index':i,'delta':delta}),('content_block_stop',{'type':'content_block_stop','index':i})]
   frames += [('message_delta',{'type':'message_delta','delta':{'stop_reason':r['stop_reason'],'stop_sequence':None},'usage':{'output_tokens':10}}),('message_stop',{'type':'message_stop'})]
   d=''.join(f'event: {ev}\ndata: {json.dumps(v)}\n\n' for ev,v in frames).encode();ct='text/event-stream'
  self.send_response(200);self.send_header('content-type',ct);self.send_header('content-length',str(len(d)));self.end_headers();self.wfile.write(d)
s=http.server.ThreadingHTTPServer(('127.0.0.1',0),API);threading.Thread(target=s.serve_forever,daemon=True).start()
with tempfile.TemporaryDirectory(prefix='edualc-elicit-') as td:
 p=pathlib.Path(td).resolve(); (p/'.claude').mkdir();(p/'.claude/settings.json').write_text(json.dumps({'disableAllHooks':True}))
 worker=p/'worker.py';heartbeat=p/'heartbeat';finished=p/'finished'
 worker.write_text("import pathlib,time\np=pathlib.Path("+repr(str(heartbeat))+ ")\nfor i in range(120):\n p.write_text(str(i));time.sleep(.25)\npathlib.Path("+repr(str(finished))+").touch()\n")
 worker_command='python3 '+str(worker)
 mcp=p/'mcp.py'
 mcp.write_text("""import sys,json,pathlib,threading,time
pending={}
lock=threading.Lock()
def emit(value):
 with lock:print(json.dumps(value),flush=True)
def run(request,stop):
 token=request.get('params',{}).get('_meta',{}).get('progressToken')
 for i in range(int(sys.argv[3])):
  if stop.wait(.25):return
  pathlib.Path(sys.argv[1]).write_text(str(i))
  if token is not None:emit({'jsonrpc':'2.0','method':'notifications/progress','params':{'progressToken':token,'progress':i+1,'total':int(sys.argv[3]),'message':'MCP_PROGRESS_587291'}})
 pathlib.Path(sys.argv[2]).touch()
 emit({'jsonrpc':'2.0','id':request['id'],'result':{'content':[{'type':'text','text':'MCP_FINISHED_574183'}]}})
for line in sys.stdin:
 request=json.loads(line);method=request.get('method')
 if method=='notifications/cancelled':
  pending.get(request.get('params',{}).get('requestId'),threading.Event()).set();continue
 if 'id' not in request:continue
 if method=='initialize':result={'protocolVersion':'2025-11-25','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
 elif method=='tools/list':result={'tools':[{'name':'slow','description':'Run the fixture background task','inputSchema':{'type':'object','properties':{}}}]}
 elif method=='tools/call':
  stop=threading.Event();pending[request['id']]=stop;threading.Thread(target=run,args=(request,stop),daemon=True).start();continue
 elif method in ('resources/list','prompts/list'):result={method.split('/')[0]:[]}
 else:result={}
 emit({'jsonrpc':'2.0','id':request['id'],'result':result})
""")
 env={k:v for k,v in os.environ.items() if not k.startswith(('ANTHROPIC_','CLAUDE_','EDUALC_','BUN_'))};env.update(HOME=str(p),ANTHROPIC_API_KEY='sk-fixture-audit',ANTHROPIC_BASE_URL=f'http://127.0.0.1:{s.server_port}',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',DISABLE_AUTOUPDATER='1',ENABLE_TOOL_SEARCH='false',HTTP_PROXY='',HTTPS_PROXY='',ALL_PROXY='',NO_PROXY='*')
 try:
  for app in os.environ.get('EDUALC_TASK_CASES','stop,complete').split(','):
   CASE=app
   AUTO_READY.clear();AUTO_RELEASE.clear();SECOND_READY.clear();SECOND_RELEASE.clear()
   heartbeat.unlink(missing_ok=True);finished.unlink(missing_ok=True);REQUESTS.clear()
   worker.write_text("import pathlib,time\np=pathlib.Path("+repr(str(heartbeat))+ ")\nfor i in range("+str(120 if app in ('stop','keyboard') else 40 if app=='keyboard_complete' else 20)+"):\n p.write_text(str(i));time.sleep(.25)\npathlib.Path("+repr(str(finished))+").touch()\nprint('SDK_BACKGROUND_COMPLETED_981472',flush=True)\n")
   (p/'.claude/settings.json').write_text(json.dumps({'disableAllHooks':True,'theme':'dark'}))
   (p/'.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'theme':'dark','projects':{str(p):{'hasTrustDialogAccepted':True}},'customApiKeyResponses':{'approved':['sk-fixture-audit'],'rejected':[]}}))
   (p/'.edualc').mkdir(exist_ok=True);(p/'.edualc/settings.json').write_text(json.dumps({'env':{'ANTHROPIC_API_KEY':'sk-fixture-audit'}}))
   current=p/'.local/share/edualc/sdk/current';current.parent.mkdir(parents=True,exist_ok=True)
   if not current.exists():current.symlink_to((pathlib.Path.home()/'.local/share/edualc/sdk/current').resolve())
   config={'mcpServers':{'fixture':{'command':'python3','args':[str(mcp),str(heartbeat),str(finished),str(120 if app=='stop' else 20)]}}} if KIND=='mcp' else {'mcpServers':{}}
   command=[str(pathlib.Path.home()/'.local/share/claude/versions/2.1.302') if os.environ.get('EDUALC_VERIFY_ORIGINAL')=='1' else str(ROOT/'bin/edualc-direct')]
   command+=['--model','claude-sonnet-4-5','--permission-mode','acceptEdits','--allowedTools','Bash,Agent,mcp__fixture__slow','--strict-mcp-config','--mcp-config',json.dumps(config)]
   env.update(TERM='xterm-256color',DISABLE_NON_ESSENTIAL_MODEL_CALLS='1')
   env['EDUALC_TRACE']='1'
   if KIND=='mcp':env.update(CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS='1000',CLAUDE_AUTO_BACKGROUND_TASKS='1')
   master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',45,130,0,0))
   child=subprocess.Popen(command,env=env,cwd=p,stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);raw=bytearray();screen=pyte.Screen(130,45);stream=pyte.ByteStream(screen)
   def drain(seconds):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
     if select.select([master],[],[],.1)[0]:
      try:data=os.read(master,65536)
      except OSError:return
      if not data:return
      raw.extend(data);stream.feed(data)
   drain(5);os.write(master,b'Run the fixture background worker.\r')
   for _ in range(100):
    drain(.2)
    if heartbeat.exists() and (CASE in ('keyboard','keyboard_complete','foreground') or b'SDK_BACKGROUND_READY_39481' in raw):break
   else:raise AssertionError('Background SDK task did not start')
   before=heartbeat.read_text();drain(.6)
   assert heartbeat.read_text()!=before, 'Worker was not alive before stop'
   if app in ('keyboard','keyboard_complete'):
    drain(3)
    (ARTIFACTS/'keyboard-foreground.txt').write_text('\n'.join(screen.display))
    assert b'SDK_BACKGROUND_READY_39481' not in raw, 'Task already returned before the background shortcut'
    os.write(master,b'\x02')
    for _ in range(80):
     drain(.15)
     if b'SDK_BACKGROUND_READY_39481' in raw and 'esc to interrupt' not in '\n'.join(screen.display).lower():break
    else:
     (ARTIFACTS/'keyboard-failed.txt').write_text('\n'.join(screen.display))
     raise AssertionError('Ctrl+B did not background the actual foreground task')
    before=heartbeat.read_text();drain(.5)
    assert heartbeat.read_text()!=before, 'Background worker stopped instead of continuing'
    (ARTIFACTS/'keyboard-background.txt').write_text('\n'.join(screen.display))
    if app=='keyboard_complete':
     for _ in range(100):
      drain(.2)
      if b'SDK_COMPLETION_PROCESSED_34918' in raw:break
     else:raise AssertionError('Backgrounded agent completed without a parent response')
     assert finished.exists(), 'Parent responded before the worker actually finished'
     (ARTIFACTS/'keyboard-completed.txt').write_text('\n'.join(screen.display))
     print(json.dumps({'ctrlB':True,'workerCompleted':True,'parentResponse':True}),flush=True)
    elif KIND=='agent':
     os.write(master,b'\x18\x0b');drain(.25)
     assert 'again to stop' in '\n'.join(screen.display).lower(), 'Kill shortcut did not request confirmation'
     os.write(master,b'\x18\x0b');drain(2)
    else:
     os.write(master,b'/tasks\r');drain(.5);os.write(master,b'x');drain(2)
    if app=='keyboard':
     before=heartbeat.read_text();drain(1)
     assert heartbeat.read_text()==before, 'Worker survived confirmed kill shortcut'
     assert not finished.exists(), 'Worker finished naturally before kill verification'
     (ARTIFACTS/'keyboard-stopped.txt').write_text('\n'.join(screen.display))
     result={'ctrlB':True,'workerContinuedInBackground':True,'killShortcutConfirmation':KIND=='agent','ctrlXCtrlKStoppedProcess':KIND=='agent','taskListStop':KIND!='agent'}
     (ARTIFACTS/'keyboard-result.json').write_text(json.dumps(result,indent=2))
     print(json.dumps(result),flush=True)
   elif app=='foreground':
    for _ in range(100):
     drain(.2)
     if b'SDK_BACKGROUND_READY_39481' in raw and finished.exists():break
    else:raise AssertionError('Foreground agent result did not reach the parent')
    (ARTIFACTS/'foreground-completed.txt').write_text('\n'.join(screen.display))
    print(json.dumps({'foregroundAgent':True,'workerCompleted':True,'parentResponse':True}),flush=True)
   elif app=='stop':
    os.write(master,b'/tasks\r');drain(1)
    (ARTIFACTS/'list.ansi').write_bytes(raw)
    (ARTIFACTS/'list.txt').write_text('\n'.join(screen.display))
    assert ('worker.py' in '\n'.join(screen.display) or 'SDK_BACKGROUND_AGENT_58271' in '\n'.join(screen.display) or 'fixture/slow' in '\n'.join(screen.display)), 'SDK task missing from original task list'
    if KIND=='mcp':assert 'MCP_PROGRESS_587291' in '\n'.join(screen.display), 'MCP progress not visible'
    os.write(master,b'x');drain(2)
    (ARTIFACTS/'stopped.ansi').write_bytes(raw)
    (ARTIFACTS/'stopped.txt').write_text('\n'.join(screen.display))
    before=heartbeat.read_text();drain(1)
    assert heartbeat.read_text()==before, 'SDK task continued after native stop'
    assert not finished.exists(), 'Worker finished instead of being stopped'
    print(json.dumps({'taskList':True,'sdkProcessStopped':True,'workerCompleted':False}),flush=True)
   elif app=='race':
    for _ in range(100):
     drain(.2)
     if AUTO_READY.is_set():break
    else:raise AssertionError('Autonomous completion API request did not start')
    os.write(master,b'USER_OVERLAP_834915 answer this second user message.\r');drain(.5)
    AUTO_RELEASE.set()
    for _ in range(100):
     drain(.2)
     if SECOND_READY.is_set():break
    else:raise AssertionError('Queued user message did not reach the SDK')
    drain(.5)
    (ARTIFACTS/'race-user-waiting.txt').write_text('\n'.join(screen.display))
    assert 'esc to interrupt' in '\n'.join(screen.display).lower(), 'Parent returned to idle before the second user response'
    SECOND_RELEASE.set()
    for _ in range(100):
     drain(.2)
     if b'SDK_SECOND_USER_835910' in raw:break
    else:raise AssertionError('Second user answer did not reach the original TUI')
    drain(1)
    (ARTIFACTS/'race-completed.txt').write_text('\n'.join(screen.display))
    assert b'SDK_COMPLETION_PROCESSED_34918' in raw, 'Autonomous response was lost'
    print(json.dumps({'autonomousAnswer':True,'secondUserAnswer':True,'noEarlyIdle':True}),flush=True)
   else:
    for _ in range(100):
     drain(.2)
     if b'SDK_COMPLETION_PROCESSED_34918' in raw:break
    else:raise AssertionError('Completed SDK task did not resume the conversation while the TUI was idle')
    drain(1)
    (ARTIFACTS/'completed.ansi').write_bytes(raw)
    (ARTIFACTS/'completed.txt').write_text('\n'.join(screen.display))
    generated=[request for request in REQUESTS if 'count_tokens' not in request['path']]
    notices=[request for request in generated if '<task-notification>' in json.dumps(request['body'].get('messages',[])) and '<status>completed</status>' in json.dumps(request['body'].get('messages',[]))]
    if app=='parallel':
     final=json.dumps(notices[-1]['body'].get('messages',[]))
     ids=re.findall(r'<task-id>(.*?)</task-id>',final)
     assert len(ids)==len(set(ids))==3, 'Parallel completion notifications were lost or duplicated'
    else:
     assert len(notices)==1, f'Completion notification was sent in {len(notices)} model requests'
     assert all(json.dumps(request['body'].get('messages',[])).count('<task-notification>')==1 for request in notices), 'Task completion entered the model context twice'
    assert all(request['sdk'] for request in generated), 'Parent generated a model response'
    print(json.dumps({'workerCompleted':True,'idleCompletionReceived':True,'completionModelCalls':len(notices),'allGenerationViaSDK':True}),flush=True)
   (ARTIFACTS/(app+'-requests.json')).write_text(json.dumps(REQUESTS,ensure_ascii=False,indent=2))
   if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);drain(1)
   child.wait(timeout=5);os.close(master)
 finally:
  AUTO_RELEASE.set();SECOND_RELEASE.set()
  stop_isolated_processes(p)
s.shutdown()
