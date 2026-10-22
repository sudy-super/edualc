# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Verify native background lifecycle against an isolated local model API."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
import traceback
import pyte

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app', type=Path, default=Path(os.environ.get('EDUALC_APP_ROOT', ROOT)))
parser.add_argument('--scenario', action='append', choices=['edualc-fresh','original-then-edualc'])
parser.add_argument('--artifacts', type=Path, default=ROOT/'test/artifacts/background')
args = parser.parse_args()
APP = args.app.resolve(strict=True)
ARTIFACT = args.artifacts.resolve()
ARTIFACT.mkdir(parents=True, exist_ok=True)
ORIGINAL = Path.home()/'.local/share/claude/versions/2.1.302'
ORIGINAL_SHA256 = hashlib.sha256(ORIGINAL.read_bytes()).hexdigest()
SDK = (Path.home()/'.local/share/edualc/sdk/current/node_modules/@anthropic-ai/claude-agent-sdk').resolve(strict=True)
PRIVATE = 'sk-edualc-background-fixture'
SHARED = 'sk-claude-background-fixture'
REQUESTS = []


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        data = b'{"data": []}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or '{}')
        if 'count_tokens' in self.path:
            result = {'input_tokens': 10}
        elif self.path.split('?')[0].endswith('/messages'):
            key = self.headers.get('x-api-key')
            prompts = [message.get('content') for message in body.get('messages', []) if message.get('role') == 'user']
            matches = re.findall(r'BG_CHECK_[A-Z_]+', json.dumps(prompts[-1:] or prompts))
            token = matches[-1] if matches else 'AUXILIARY'
            response = 'SERVER_ONLY_REPLY_' + token
            REQUESTS.append({'model':body.get('model'), 'credential':'private' if key == PRIVATE else 'shared' if key == SHARED else 'other',
                'authorization_present':bool(self.headers.get('authorization')), 'user_agent':self.headers.get('user-agent'),
                'prompt_token':token, 'response':response, 'request':body})
            schema=body.get('output_config',{}).get('format',{}).get('schema',{})
            if 'title' in schema.get('properties',{}):
                response=json.dumps({'title':'Background regression'})
            elif 'OUTPUT' in json.dumps(body.get('system',[])) and 'tempo' in json.dumps(body.get('system',[])):
                response=json.dumps({'state':'done','detail':'Background check completed','tempo':'idle','output':{'result':'Background check completed'}})
            result = {'id':'msg_bg_fixture', 'type':'message', 'role':'assistant', 'model':body.get('model','claude-opus-5'),
                'content':[{'type':'text','text':response}], 'stop_reason':'end_turn', 'stop_sequence':None,
                'usage':{'input_tokens':10,'output_tokens':10}}
        else:
            result = {}
        if body.get('stream') and 'content' in result:
            frames = [('message_start',{'type':'message_start','message':{**result,'content':[],'stop_reason':None}}),
                ('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),
                ('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':response}}),
                ('content_block_stop',{'type':'content_block_stop','index':0}),
                ('message_delta',{'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':10}}),
                ('message_stop',{'type':'message_stop'})]
            data=''.join(f'event: {name}\ndata: {json.dumps(value)}\n\n' for name,value in frames).encode()
            content='text/event-stream'
        else:
            data=json.dumps(result).encode();content='application/json'
        self.send_response(200)
        self.send_header('Content-Type',content)
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Terminal:
    def __init__(self, command, env, work):
        self.raw=bytearray()
        self.master,slave=pty.openpty()
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,110,0,0))
        self.screen=pyte.Screen(110,40)
        self.stream=pyte.ByteStream(self.screen)
        self.process=subprocess.Popen([str(x) for x in command],cwd=work,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave)

    def drain(self, seconds):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            if not select.select([self.master],[],[],min(.05,max(0,end-time.monotonic())))[0]:
                continue
            try:
                data=os.read(self.master,65536)
            except OSError:
                break
            if not data:
                break
            self.raw.extend(data)
            self.stream.feed(data)

    def wait(self, marker, timeout=35):
        end=time.monotonic()+timeout
        while marker.encode() not in self.raw and marker not in '\n'.join(self.screen.display):
            self.drain(.1)
            if self.process.poll() is not None:
                raise AssertionError(f'Exited before {marker}: '+self.raw.decode(errors='replace'))
            if time.monotonic()>end:
                raise AssertionError(f'Timeout before {marker}: '+'\n'.join(self.screen.display))
            if 'Choose the text style' in '\n'.join(self.screen.display):
                os.write(self.master,b'\r')
                self.drain(.3)

    def close(self, name):
        self.drain(.2)
        (ARTIFACT/f'{name}.ansi').write_bytes(self.raw)
        (ARTIFACT/f'{name}.txt').write_text('\n'.join(self.screen.display))
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        os.close(self.master)


def isolated_processes(home):
    output=subprocess.run(['ps','axeww','-o','pid=,command='],text=True,capture_output=True,check=True).stdout
    return [(int(line.split(None,1)[0]),line.split(None,1)[1]) for line in output.splitlines()
        if f'HOME={home}' in line and int(line.split(None,1)[0])!=os.getpid()]


def alive(pid):
    try:
        os.kill(pid,0)
        return True
    except ProcessLookupError:
        return False


def run(command,env,work,case):
    result=subprocess.run([str(x) for x in command],env=env,cwd=work,capture_output=True,text=True,timeout=35)
    value={'arguments':[str(x) for x in command], 'code':result.returncode,'stdout':result.stdout,'stderr':result.stderr}
    (ARTIFACT/f'{case}.json').write_text(json.dumps(value,indent=2)+'\n')
    assert result.returncode == 0, value
    return value


def listing(binary, env, work, label):
    return json.loads(run([binary,'agents','--json','--all'],env,work,label)['stdout'])


def wait_for(callback, description, timeout=35):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        value=callback()
        if value:
            return value
        time.sleep(.2)
    raise AssertionError('Timeout: '+description)


def trace_events(offset):
    path=APP/'test/artifacts/sdk-run.jsonl'
    return [json.loads(line) for line in path.read_bytes()[offset:].splitlines()] if path.exists() else []


def session_complete(binary, identifier, token, env, work, label):
    marker='SERVER_ONLY_REPLY_'+token
    def complete():
        rows=listing(binary,env,work,label+'-status')
        row=next((r for r in rows if r['id']==identifier),None)
        if not row or row.get('status') != 'idle':
            return False
        logs=run([binary,'logs',identifier],env,work,label+'-logs')['stdout']
        paths=list((Path(env['HOME'])/'.claude/projects').rglob(row['sessionId']+'.jsonl'))
        saved=any(message.get('type')=='assistant' and any(
            block.get('type')=='text' and marker in block.get('text','')
            for block in message.get('message',{}).get('content',[]) if isinstance(block,dict))
            for path in paths for line in path.read_text().splitlines() if line
            for message in [json.loads(line)])
        (ARTIFACT/f'{label}-history.json').write_text(json.dumps({'session_id':row['sessionId'],'saved_assistant_reply':saved})+'\n')
        return row if logs and saved else False
    return wait_for(complete,'completed model response '+token)


def attached_turn(binary, identifier, token, env, work, label):
    terminal=Terminal([binary,'attach',identifier],env,work)
    try:
        terminal.drain(2)
        assert terminal.process.poll() is None, terminal.raw.decode(errors='replace')
        os.write(terminal.master,('Reply briefly. '+token+'\r').encode())
        terminal.wait('SERVER_ONLY_REPLY_'+token)
        session_complete(binary,identifier,token,env,work,label)
        os.write(terminal.master,b'\x1a')
        end=time.monotonic()+8
        while terminal.process.poll() is None and time.monotonic()<end:
            terminal.drain(.1)
        assert terminal.process.poll()==0, ('Ctrl+Z did not detach cleanly',terminal.process.poll())
    finally:
        terminal.close(label)


server=ThreadingHTTPServer(('127.0.0.1',0),Fixture)
threading.Thread(target=server.serve_forever,daemon=True).start()
results=[]
for scenario in args.scenario or ['edualc-fresh','original-then-edualc']:
    print(scenario,flush=True)
    with tempfile.TemporaryDirectory(prefix='edualc-background-') as directory:
        home=Path(directory).resolve()
        work=home/'work'
        work.mkdir()
        (home/'.claude').mkdir()
        (home/'.edualc').mkdir()
        (home/'.claude/settings.json').write_text(json.dumps({'theme':'dark','disableAllHooks':True,'env':{'ANTHROPIC_API_KEY':SHARED}}))
        (home/'.edualc/settings.json').write_text(json.dumps({'env':{'ANTHROPIC_API_KEY':PRIVATE}}))
        (home/'.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'theme':'dark',
            'customApiKeyResponses':{'approved':[PRIVATE[-20:],SHARED[-20:]],'rejected':[]},
            'projects':{str(work):{'hasTrustDialogAccepted':True}}}))
        current=home/'.local/share/edualc/sdk/current'
        current.parent.mkdir(parents=True)
        current.symlink_to(SDK.parents[2],target_is_directory=True)
        env={k:v for k,v in os.environ.items() if k in ('PATH','TMPDIR','LANG','LC_ALL')}
        env.update({'HOME':str(home),'ANTHROPIC_API_KEY':SHARED,'ANTHROPIC_BASE_URL':f'http://127.0.0.1:{server.server_port}',
            'EDUALC_TRACE':'1','CLAUDE_CODE_MODEL_CATALOG':'off','DISABLE_AUTOUPDATER':'1','DISABLE_NON_ESSENTIAL_MODEL_CALLS':'1',
            'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','TERM':'xterm-256color','HTTP_PROXY':'','HTTPS_PROXY':'','ALL_PROXY':'',
            'http_proxy':'','https_proxy':'','all_proxy':'','NO_PROXY':'*','no_proxy':'*'})
        outcome={'scenario':scenario,'checks':[]}
        start=len(REQUESTS)
        trace=APP/'test/artifacts/sdk-run.jsonl'
        trace_offset=trace.stat().st_size if trace.exists() else 0
        spawned=set()
        try:
            original_row=None
            if scenario=='original-then-edualc':
                token='BG_CHECK_ORIGINAL'
                run([ORIGINAL,'--bg','--model','claude-opus-5','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--','Reply briefly. '+token],env,work,scenario+'-original-launch')
                rows=wait_for(lambda:listing(ORIGINAL,env,work,scenario+'-original-list'),'original session')
                assert len(rows)==1, rows
                original_row=session_complete(ORIGINAL,rows[0]['id'],token,env,work,scenario+'-original')
                original_pids={pid for pid,_ in isolated_processes(home)}
                spawned.update(original_pids)
                old_original_pid=original_row['pid']
                run([ORIGINAL,'respawn',original_row['id']],env,work,scenario+'-original-respawn')
                def original_respawned():
                    return next((r for r in listing(ORIGINAL,env,work,scenario+'-original-respawn-status') if r['id']==original_row['id'] and r.get('pid') and r['pid']!=old_original_pid),None)
                new_original=wait_for(original_respawned,'original respawn')
                attached_turn(ORIGINAL,new_original['id'],'BG_CHECK_ORIGINAL_RESPAWN',env,work,scenario+'-original-respawn-attached')
                new_original=next(r for r in listing(ORIGINAL,env,work,scenario+'-original-after-respawn-turn') if r['id']==original_row['id'])
                original_requests=[r for r in REQUESTS[start:] if r['prompt_token']=='BG_CHECK_ORIGINAL_RESPAWN']
                assert original_requests and 'BG_CHECK_ORIGINAL' in json.dumps(original_requests[-1]['request']['messages']), original_requests
                assert new_original['sessionId']==original_row['sessionId'], (original_row,new_original)
                outcome['original_respawn']={'before_session_id':original_row['sessionId'],'after_session_id':new_original['sessionId']}
                original_row=new_original
                original_pids={pid for pid,_ in isolated_processes(home)}
                spawned.update(original_pids)
                outcome['original_daemon_pid']=json.loads((home/'.claude/daemon.status.json').read_text())['supervisorPid']
                outcome['original_session']=original_row
                outcome['checks'].append('unmodified original background service completes a conversation')
            binary=APP/'bin/edualc-direct'
            assert listing(binary,env,work,scenario+'-before')==[], 'edualc reused original daemon sessions'
            model_start=len(REQUESTS)
            run([binary,'--bg','--model','claude-opus-5','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--','Reply briefly. BG_CHECK_INITIAL'],env,work,scenario+'-launch')
            rows=wait_for(lambda:listing(binary,env,work,scenario+'-list'),'edualc session')
            assert len(rows)==1, rows
            identifier=rows[0]['id']
            row=session_complete(binary,identifier,'BG_CHECK_INITIAL',env,work,scenario+'-initial')
            spawned.update(pid for pid,_ in isolated_processes(home))
            daemon_pid=json.loads((home/'.edualc/daemon.status.json').read_text())['supervisorPid']
            assert alive(daemon_pid), daemon_pid
            outcome['daemon_pid']=daemon_pid
            if original_row:
                assert daemon_pid!=outcome['original_daemon_pid'], outcome
            outcome['session_id']=row['sessionId']
            outcome['checks'].append('cold background launch displays a server-generated response')
            for token in ['BG_CHECK_ATTACHED','BG_CHECK_REATTACHED']:
                attached_turn(binary,identifier,token,env,work,scenario+'-'+token.lower())
                outcome['checks'].append(token+': attach, model response, Ctrl+Z detach')
            old_pid=next(r['pid'] for r in listing(binary,env,work,scenario+'-pre-respawn') if r['id']==identifier)
            run([binary,'respawn',identifier],env,work,scenario+'-respawn')
            def respawned():
                return next((r for r in listing(binary,env,work,scenario+'-respawn-status') if r['id']==identifier and r.get('pid')!=old_pid),None)
            new_row=wait_for(respawned,'new background PID after respawn')
            outcome['respawn_session_id']=new_row['sessionId']
            spawned.update(pid for pid,_ in isolated_processes(home))
            attached_turn(binary,identifier,'BG_CHECK_RESPAWNED',env,work,scenario+'-respawn-attached')
            new_row=next(r for r in listing(binary,env,work,scenario+'-after-respawn-turn') if r['id']==identifier)
            outcome['respawn_session_id']=new_row['sessionId']
            assert new_row['sessionId']==row['sessionId'], (row,new_row)
            outcome['checks'].append('respawn keeps session ID, history and SDK connection, then attach/detach works')
            def spare_processes():
                return {pid for pid,command in isolated_processes(home) if ' --bg-spare ' in command.split(' LANG=')[0].split(' PATH=')[0] and str(APP/'native/edualc') in command.split(' LANG=')[0].split(' PATH=')[0] and pid!=new_row['pid']}
            spares=wait_for(spare_processes,'ready native warm spare')
            spawned.update(spares)
            run([binary,'--bg','--','Reply briefly. BG_CHECK_WARM'],env,work,scenario+'-warm-launch')
            def warm_created():
                return next((r for r in listing(binary,env,work,scenario+'-warm-status') if r['id']!=identifier),None)
            warm=wait_for(warm_created,'warm background session')
            warm=session_complete(binary,warm['id'],'BG_CHECK_WARM',env,work,scenario+'-warm')
            assert warm['pid'] in spares, ('warm session did not claim a pre-existing spare', warm['pid'],spares)
            outcome['warm_spare']={'preexisting_pids':sorted(spares),'claimed_pid':warm['pid'],'session_id':warm['sessionId']}
            spawned.update(pid for pid,_ in isolated_processes(home))
            outcome['checks'].append('plain --bg claims a pre-existing native warm spare and completes via SDK')
            records=REQUESTS[model_start:]
            resumed_requests=[r for r in records if r['prompt_token']=='BG_CHECK_RESPAWNED']
            assert resumed_requests and 'BG_CHECK_REATTACHED' in json.dumps(resumed_requests[-1]['request']['messages']), resumed_requests
            assert records and all(r['credential']=='private' and not r['authorization_present'] for r in records), records
            assert all('sdk-cli' in (r['user_agent'] or '') and 'agent-sdk/' in r['user_agent'] for r in records), [(r['prompt_token'],r['user_agent']) for r in records]
            events=trace_events(trace_offset)
            assert sum(e.get('kind')=='sdk_start' for e in events)>=2, events
            assert sum(e.get('kind')=='sdk_turn' for e in events)>=4, events
            assert sum(e.get('kind')=='sdk_event' and e.get('type')=='result' for e in events)>=4, events
            history=home/'.claude/projects'
            assert list(history.rglob(row['sessionId']+'.jsonl')), list(history.rglob('*'))
            outcome['checks'].append('all edualc requests use private API key and SDK user agent; trace confirms completed SDK turns')
            outcome['checks'].append('parent session history stays in the shared .claude/projects directory')
            if original_row:
                outcome['original_listing_while_edualc_active']=listing(ORIGINAL,env,work,scenario+'-original-while-edualc-active')
            run([binary,'stop',identifier],env,work,scenario+'-stop')
            wait_for(lambda:not alive(new_row['pid']),'background child stopped')
            run([binary,'rm',identifier],env,work,scenario+'-rm')
            assert not any(r['id']==identifier for r in listing(binary,env,work,scenario+'-removed'))
            run([binary,'stop',warm['id']],env,work,scenario+'-warm-stop')
            wait_for(lambda:not alive(warm['pid']),'warm background child stopped')
            run([binary,'rm',warm['id']],env,work,scenario+'-warm-rm')
            assert listing(binary,env,work,scenario+'-all-removed')==[]
            outcome['checks'].append('stop exits both background children and rm removes their sessions')
            if original_row:
                original_after=listing(ORIGINAL,env,work,scenario+'-original-after')
                retained_original=next((r for r in original_after if r['id']==original_row['id']),None)
                assert retained_original and retained_original['sessionId']==original_row['sessionId'] and retained_original.get('pid')==original_row['pid'],original_after
                outcome['original_listing_after']=original_after
                assert alive(original_row['pid']), original_row
                assert alive(outcome['original_daemon_pid']), outcome['original_daemon_pid']
                outcome['checks'].append('original daemon and original session remain alive and separate')
            outcome['sdk_trace']=events
            outcome['status']='passed'
        except Exception:
            outcome['status']='failed'
            outcome['error']=traceback.format_exc()
        finally:
            outcome['requests']=REQUESTS[start:]
            outcome['sdk_trace']=trace_events(trace_offset)
            outcome['files']=[str(p.relative_to(home)) for p in home.rglob('*') if p.is_file() and not p.is_symlink()]
            spawned.update(pid for pid,_ in isolated_processes(home))
            for pid in spawned:
                try:os.kill(pid,signal.SIGTERM)
                except ProcessLookupError:pass
            end=time.monotonic()+3
            while time.monotonic()<end and isolated_processes(home):
                time.sleep(.1)
            for pid,_ in isolated_processes(home):
                spawned.add(pid)
                try:os.kill(pid,signal.SIGKILL)
                except ProcessLookupError:pass
            end=time.monotonic()+3
            while time.monotonic()<end and isolated_processes(home):
                time.sleep(.1)
            remaining=[pid for pid in spawned if alive(pid)]
            outcome['cleanup']={'spawned_pids':sorted(spawned),'remaining_pids':remaining,'all_spawned_processes_exited':not remaining}
            if remaining:
                outcome['status']='failed'
                outcome['cleanup_error']='isolated processes remained after cleanup'
        results.append(outcome)
server.shutdown()
report={'app':str(APP),'isolated_home':True,'model_api':'localhost fixture only','original_sha256':ORIGINAL_SHA256,
    'original_binary_unchanged':hashlib.sha256(ORIGINAL.read_bytes()).hexdigest()==ORIGINAL_SHA256,'scenarios':results}
(ARTIFACT/'result.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps([{'scenario':x['scenario'],'status':x['status'],'checks':x['checks'],'cleanup':x['cleanup'],'error':x.get('error')} for x in results],indent=2))
assert report['original_binary_unchanged'], 'original binary changed'
assert all(x['status']=='passed' for x in results), 'background lifecycle regression failed'
