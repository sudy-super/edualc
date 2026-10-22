# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Send real Escape during held HTTP and thinking SSE, then complete another turn."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import fcntl,json,os,pathlib,pty,select,socket,struct,subprocess,tempfile,termios,threading,time
import pyte
from fixture_processes import stop_isolated_processes
ROOT=pathlib.Path(os.environ.get('EDUALC_APP_ROOT',pathlib.Path(__file__).resolve().parents[1])).resolve()
ORIGINAL=os.environ.get('EDUALC_VERIFY_ORIGINAL')=='1'
ARTIFACT=pathlib.Path(__file__).resolve().parents[1]/'test/artifacts/interrupt'/('original' if ORIGINAL else os.environ.get('EDUALC_INTERRUPT_LABEL','edualc'))
ARTIFACT.mkdir(parents=True,exist_ok=True)
KEY='sk-interrupt-private-fixture'
INTERRUPT_KEY={'escape':b'\x1b','ctrl-c':b'\x03'}[os.environ.get('EDUALC_INTERRUPT_KEY','escape')]
requests=[];started=threading.Event();cancelled=threading.Event();mode='held'
class API(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  b=json.loads(self.rfile.read(int(self.headers.get('content-length',0))) or '{}')
  requests.append({'privateKey':self.headers.get('x-api-key')==KEY,'sdk':'agent-sdk/' in self.headers.get('user-agent',''),'model':b.get('model'),'path':self.path,'messages':b.get('messages',[])})
  if 'count_tokens' in self.path:
   data=json.dumps({'input_tokens':10}).encode();self.send_response(200);self.send_header('content-length',str(len(data)));self.end_headers();self.wfile.write(data);return
  child=any('INTERRUPT_AGENT_CHILD_38175' in (message['content'] if isinstance(message.get('content'),str) else ' '.join(str(block.get('text','')) for block in message.get('content',[]) if isinstance(block,dict))) for message in b.get('messages',[]) if message.get('role')=='user')
  agents=mode=='agents' and bool(b.get('tools')) and not child and 'INTERRUPT_NEXT_928471' not in json.dumps(b.get('messages',[]))
  slow=bool(b.get('tools')) and (child or 'INTERRUPT_SLOW_451927' in json.dumps(b.get('messages',[])) and 'INTERRUPT_NEXT_928471' not in json.dumps(b.get('messages',[])))
  r={'id':'msg_interrupt_fixture','type':'message','role':'assistant','model':b['model'],'content':[],'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':0}}
  def frame(event,value):return f'event: {event}\ndata: {json.dumps(value)}\n\n'.encode()
  if slow and not agents:
   started.set()
   if mode=='thinking':
    self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers()
    self.wfile.write(frame('message_start',{'type':'message_start','message':r})+frame('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'thinking','thinking':'','signature':''}})+frame('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'thinking_delta','thinking':'FIXTURE_THINKING_528174'}}));self.wfile.flush()
   deadline=time.monotonic()+35
   while time.monotonic()<deadline:
    if select.select([self.connection],[],[],.1)[0]:
     if not self.connection.recv(1,socket.MSG_PEEK):cancelled.set();return
   return
  text='INTERRUPT_NEXT_OK_582719'
  if agents:
   content=[{'type':'tool_use','id':f'toolu_interrupt_agent_{i}','name':'Agent','input':{'subagent_type':'general-purpose','description':f'Interrupt agent {i}','prompt':'INTERRUPT_AGENT_CHILD_38175 Wait for fixture response.','run_in_background':False}} for i in range(4)]
   data=json.dumps({**r,'content':content,'stop_reason':'tool_use','usage':{'input_tokens':10,'output_tokens':10}}).encode()
   if b.get('stream'):
    frames=[frame('message_start',{'type':'message_start','message':r})]
    for index,block in enumerate(content):
     frames += [frame('content_block_start',{'type':'content_block_start','index':index,'content_block':{**block,'input':{}}}),frame('content_block_delta',{'type':'content_block_delta','index':index,'delta':{'type':'input_json_delta','partial_json':json.dumps(block['input'])}}),frame('content_block_stop',{'type':'content_block_stop','index':index})]
    frames += [frame('message_delta',{'type':'message_delta','delta':{'stop_reason':'tool_use','stop_sequence':None},'usage':{'output_tokens':10}}),frame('message_stop',{'type':'message_stop'})]
    data=b''.join(frames)
   self.send_response(200);self.send_header('content-type','text/event-stream' if b.get('stream') else 'application/json');self.send_header('content-length',str(len(data)));self.end_headers();self.wfile.write(data);return
  frames=[frame('message_start',{'type':'message_start','message':r}),frame('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),frame('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':text}}),frame('content_block_stop',{'type':'content_block_stop','index':0}),frame('message_delta',{'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':10}}),frame('message_stop',{'type':'message_stop'})]
  data=b''.join(frames) if b.get('stream') else json.dumps({**r,'content':[{'type':'text','text':text}],'stop_reason':'end_turn'}).encode()
  self.send_response(200);self.send_header('content-type','text/event-stream' if b.get('stream') else 'application/json');self.send_header('content-length',str(len(data)));self.end_headers();self.wfile.write(data)
server=ThreadingHTTPServer(('127.0.0.1',0),API);threading.Thread(target=server.serve_forever,daemon=True).start()
checks=[]
try:
 for mode in os.environ.get('EDUALC_INTERRUPT_MODES','held,thinking,agents').split(','):
  started.clear();cancelled.clear();requests.clear()
  with tempfile.TemporaryDirectory(prefix='edualc-interrupt-') as td:
   home=pathlib.Path(td).resolve();work=home/'work';work.mkdir();(home/'.claude').mkdir();(home/'.edualc').mkdir()
   (home/'.claude/settings.json').write_text(json.dumps({'disableAllHooks':True,'theme':'dark','tui':'fullscreen'}))
   (home/'.edualc/settings.json').write_text(json.dumps({'env':{'ANTHROPIC_API_KEY':KEY}}))
   (home/'.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'theme':'dark','projects':{str(work):{'hasTrustDialogAccepted':True}},'customApiKeyResponses':{'approved':[KEY],'rejected':[]}}))
   current=home/'.local/share/edualc/sdk/current';current.parent.mkdir(parents=True);current.symlink_to((pathlib.Path.home()/'.local/share/edualc/sdk/current').resolve())
   env={k:v for k,v in os.environ.items() if not k.startswith(('ANTHROPIC_','CLAUDE_','EDUALC_','BUN_'))}
   env.update(HOME=str(home),TERM='xterm-256color',ANTHROPIC_API_KEY=KEY,ANTHROPIC_BASE_URL=f'http://127.0.0.1:{server.server_port}',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',DISABLE_AUTOUPDATER='1',DISABLE_NON_ESSENTIAL_MODEL_CALLS='1',ENABLE_TOOL_SEARCH='false',EDUALC_TRACE='1',HTTP_PROXY='',HTTPS_PROXY='',ALL_PROXY='',http_proxy='',https_proxy='',all_proxy='',NO_PROXY='*',no_proxy='*')
   executable=pathlib.Path('/Users/rakuto/.local/share/claude/versions/2.1.302') if ORIGINAL else ROOT/'bin/edualc-direct'
   master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',45,130,0,0))
   child=subprocess.Popen([str(executable),'--model','claude-sonnet-4-5','--allowedTools','Agent','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'],env=env,cwd=work,stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave)
   trace_path=ROOT/'test/artifacts/sdk-run.jsonl';trace_offset=trace_path.stat().st_size if trace_path.exists() else 0
   raw=bytearray();screen=pyte.Screen(130,45);stream=pyte.ByteStream(screen)
   def drain(duration=.1):
    end=time.monotonic()+duration
    while time.monotonic()<end:
     if select.select([master],[],[],.02)[0]:
      try:data=os.read(master,65536)
      except OSError:return
      if not data:return
      raw.extend(data);stream.feed(data)
   def wait(predicate,reason,timeout=20):
    end=time.monotonic()+timeout
    while not predicate():
     drain()
     if 'Do you want to use this API key?' in '\n'.join(screen.display):os.write(master,b'\x1b[A\r');drain(.3)
     if 'Choose the text style' in '\n'.join(screen.display):os.write(master,b'\r');drain(.3)
     if child.poll() is not None:raise AssertionError(f'process exited: {child.returncode}: {reason}')
     if time.monotonic()>end:raise AssertionError(reason+'\n'+'\n'.join(screen.display))
   try:
    wait(lambda:'Sonnet 4.5' in '\n'.join(screen.display),'TUI did not start')
    os.write(master,b'INTERRUPT_SLOW_451927 Think through the fixture.\r')
    wait(started.is_set,'held API did not start')
    wait(lambda:'esc to interrupt' in '\n'.join(screen.display).lower(),'TUI did not enter generating state')
    drain(.4);os.write(master,INTERRUPT_KEY);start=time.monotonic()
    wait(cancelled.is_set,'Escape did not cancel the actual API connection',10)
    wait(lambda:'esc to interrupt' not in '\n'.join(screen.display).lower(),'TUI stayed busy after Escape',8)
    drain(1.5)
    diagnostic='ede_diagnostic' in raw.decode('utf-8',errors='replace')
    if os.environ.get('EDUALC_INTERRUPT_EXPECT_DIAGNOSTIC')=='1':assert diagnostic, 'Expected interrupted-agent diagnostic was not reproduced'
    else:assert not diagnostic, 'Interrupted result was rendered as a diagnostic error'
    elapsed=time.monotonic()-start
    (ARTIFACT/f'{mode}-cancelled.txt').write_text('\n'.join(screen.display))
    os.write(master,b'\x15INTERRUPT_NEXT_928471 Answer the next message.\r')
    wait(lambda:'INTERRUPT_NEXT_OK_582719' in '\n'.join(screen.display),'next user message did not complete')
    wait(lambda:'esc to interrupt' not in '\n'.join(screen.display).lower(),'next user message remained busy')
    assert all(r['privateKey'] for r in requests), 'request did not use fixture API key'
    checks.append({'case':mode,'apiConnectionCancelled':True,'spinnerStopped':True,'nextTurnCompleted':True,'seconds':round(elapsed,3),'privateKey':True,'diagnosticDisplayed':diagnostic})
    print(json.dumps(checks[-1]),flush=True)
   finally:
    (ARTIFACT/f'{mode}-requests.json').write_text(json.dumps(requests,indent=2))
    (ARTIFACT/f'{mode}-last.txt').write_text('\n'.join(screen.display));(ARTIFACT/f'{mode}.ansi').write_bytes(raw)
    if trace_path.exists():(ARTIFACT/f'{mode}-trace.jsonl').write_bytes(trace_path.read_bytes()[trace_offset:])
    if child.poll() is None:child.terminate()
    try:child.wait(timeout=3)
    except subprocess.TimeoutExpired:child.kill();child.wait()
    os.close(master);stop_isolated_processes(home)
finally:
 (ARTIFACT/'result.json').write_text(json.dumps({'checks':checks},indent=2));server.shutdown()
