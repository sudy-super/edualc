"""Check original MCP input dialogs against a localhost API and MCP server."""
import os,tempfile,json,pathlib,subprocess,threading,http.server,pty,fcntl,termios,struct,select,time,signal,re
from fixture_processes import stop_isolated_processes
ROOT=pathlib.Path(os.environ.get("EDUALC_APP_ROOT", pathlib.Path(__file__).resolve().parents[1]))
ARTIFACTS=pathlib.Path(__file__).resolve().parents[1]/"test/artifacts/elicitation"
ARTIFACTS.mkdir(parents=True,exist_ok=True)
class API(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  b=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if 'count_tokens' in self.path:r={'input_tokens':10}
  else:
   done='ELICIT_RESULT_' in json.dumps(b.get('messages',[]))
   c=[{'type':'text','text':'AUDIT_DONE'}] if done else [{'type':'tool_use','id':'toolu_elicit','name':'mcp__fixture__elicit','input':{}}]
   r={'id':'msg_fixture','type':'message','role':'assistant','model':b['model'],'content':c,'stop_reason':'end_turn' if done else 'tool_use','stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':10}}
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
 mcp=p/'mcp.py';log=p/'elicit.jsonl'
 mcp.write_text('''import sys,json,pathlib
pending=None
for l in sys.stdin:
 r=json.loads(l)
 if r.get('id')=='form-request':
  pathlib.Path(sys.argv[1]).open('a').write(json.dumps(r)+'\\n')
  print(json.dumps({'jsonrpc':'2.0','id':pending,'result':{'content':[{'type':'text','text':'ELICIT_RESULT_'+json.dumps(r)}]}}),flush=True)
  continue
 if 'method' not in r or 'id' not in r:continue
 m=r['method']
 if m=='initialize':v={'protocolVersion':'2025-11-25','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
 elif m=='tools/list':v={'tools':[{'name':'elicit','description':'Request a test form','inputSchema':{'type':'object','properties':{}}}]}
 elif m=='tools/call':
  pending=r['id'];print(json.dumps({'jsonrpc':'2.0','id':'form-request','method':'elicitation/create','params':{'mode':'form','message':'ELICIT_FORM_AUDIT_82937','requestedSchema':{'type':'object','properties':{'name':{'type':'string','title':'Name','default':'audit'}},'required':['name']}}}),flush=True);continue
 elif m in ('resources/list','prompts/list'):v={m.split('/')[0]:[]}
 else:v={}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':v}),flush=True)
''')
 env={k:v for k,v in os.environ.items() if not k.startswith(('ANTHROPIC_','CLAUDE_','EDUALC_','BUN_'))};env.update(HOME=str(p),ANTHROPIC_API_KEY='sk-fixture-audit',ANTHROPIC_BASE_URL=f'http://127.0.0.1:{s.server_port}',MCP=str(mcp),LOG=str(log),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',DISABLE_AUTOUPDATER='1',ENABLE_TOOL_SEARCH='false',HTTP_PROXY='',HTTPS_PROXY='',ALL_PROXY='',NO_PROXY='*')
 try:
  for app in ['accept','decline','cancel']:
   (p/'.claude/settings.json').write_text(json.dumps({'disableAllHooks':True,'theme':'dark'}))
   (p/'.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'theme':'dark','projects':{str(p):{'hasTrustDialogAccepted':True}},'customApiKeyResponses':{'approved':['sk-fixture-audit'],'rejected':[]}}))
   (p/'.edualc').mkdir(exist_ok=True);(p/'.edualc/settings.json').write_text(json.dumps({'env':{'ANTHROPIC_API_KEY':'sk-fixture-audit'}}))
   current=p/'.local/share/edualc/sdk/current';current.parent.mkdir(parents=True,exist_ok=True)
   if not current.exists():current.symlink_to((pathlib.Path.home()/'.local/share/edualc/sdk/current').resolve())
   config={'mcpServers':{'fixture':{'command':'python3','args':[str(mcp),str(log)]}}}
   command=[str(ROOT/'bin/edualc-direct')]
   command+=['--model','claude-sonnet-4-5','--permission-mode','acceptEdits','--allowedTools','mcp__fixture__elicit','--strict-mcp-config','--mcp-config',json.dumps(config)]
   env.update(TERM='xterm-256color',DISABLE_NON_ESSENTIAL_MODEL_CALLS='1')
   master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',45,130,0,0))
   child=subprocess.Popen(command,env=env,cwd=p,stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);raw=bytearray()
   def drain(seconds):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
     if select.select([master],[],[],.1)[0]:
      try:data=os.read(master,65536)
      except OSError:return
      if not data:return
      raw.extend(data)
   drain(5);os.write(master,b'Use elicit tool.\r');drain(8)
   shown=b'ELICIT_FORM_AUDIT_82937' in raw
   assert shown, 'Original MCP form did not appear'
   if app=='cancel':os.write(master,b'\x1b')
   else:
    os.write(master,b'\x1b[B');drain(.4)
    if app=='decline':os.write(master,b'\x1b[B');drain(.4)
    os.write(master,b'\r')
   drain(4)
   (ARTIFACTS/(app+'.ansi')).write_bytes(raw)
   response=json.loads(log.read_text().splitlines()[0])['result'] if log.exists() else None
   assert response and response['action']==app, (app,response)
   if app=='accept':assert response['content']=={'name':'audit'}, response
   assert b'AUDIT_DONE' in raw, 'SDK did not finish the tool result turn'
   print(json.dumps({'action':app,'formShown':shown,'mcpResponse':response,'completed':True}),flush=True)
   if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);drain(1)
   child.wait(timeout=5);os.close(master);log.unlink(missing_ok=True)
 finally:
  stop_isolated_processes(p)
s.shutdown()
