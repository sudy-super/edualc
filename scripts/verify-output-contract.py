# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Exercise the installed native TUI/SDK bridge against a local Messages fixture."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
import pyte
from fixture_processes import stop_isolated_processes

SOURCE_ROOT = Path(__file__).resolve().parents[1]
ROOT = Path(os.environ.get('EDUALC_APP_ROOT', SOURCE_ROOT)).resolve()
ARTIFACT = ROOT / 'test/artifacts/output-contract'
ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
work = None


class Terminal:
    def __init__(self, environment, arguments, name, binary=None):
        self.name, self.raw = name, bytearray()
        self.screen = pyte.Screen(110, 40)
        self.stream = pyte.ByteStream(self.screen)
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 110, 0, 0))
        self.process = subprocess.Popen([str(binary or ROOT / 'native/edualc'), *arguments], cwd=work,
                       env=environment, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)

    def drain(self, duration=.1):
        until = time.monotonic() + duration
        while time.monotonic() < until:
            if select.select([self.master], [], [], min(.05, max(0, until-time.monotonic())))[0]:
                try:
                    data = os.read(self.master, 65536)
                except OSError:
                    return
                self.raw.extend(data)
                self.stream.feed(data)
                ARTIFACT.with_name(f'output-contract-{self.name}.txt').write_text('\n'.join(self.screen.display)+'\n')

    def send(self, text):
        os.write(self.master, text.encode())

    def wait(self, text, timeout=45):
        print(f'{self.name}: waiting for {text}', flush=True)
        until = time.monotonic() + timeout
        while text not in '\n'.join(self.screen.display):
            self.drain()
            display = '\n'.join(self.screen.display)
            if text == 'Opus 5' and 'Choose the text style' in display:
                self.send('\r')
                self.drain(.3)
            if text == 'Opus 5' and 'Yes, I trust this folder' in display:
                self.send('\x1b[B\r')
                self.drain(.3)
            if self.process.poll() is not None:
                raise AssertionError(f'{self.name}: exited {self.process.returncode} waiting for {text}')
            if time.monotonic() > until:
                raise AssertionError(f'{self.name}: timed out waiting for {text}')

    def stop(self):
        self.drain()
        ARTIFACT.with_name(f'output-contract-{self.name}.ansi').write_bytes(self.raw)
        ARTIFACT.with_name(f'output-contract-{self.name}.txt').write_text('\n'.join(self.screen.display)+'\n')
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        os.close(self.master)



checks = []
with tempfile.TemporaryDirectory(prefix='edualc-output-ui-') as temporary:
    home = Path(temporary).resolve()
    work = home / 'work'
    work.mkdir()
    (home / '.claude').mkdir()
    (home / '.claude/settings.json').write_text(json.dumps({'tui':'fullscreen','theme':'dark','disableAllHooks':True}))
    (home / '.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'theme':'dark','projects':{str(work):{'hasTrustDialogAccepted':True}}}))
    environment = {k:v for k,v in os.environ.items() if not k.startswith(('ANTHROPIC_','CLAUDE_','EDUALC_','BUN_'))}
    environment.update({'HOME':str(home),'TERM':'xterm-256color','CLAUDE_CODE_OAUTH_TOKEN':'original-oauth-fixture',
        'ANTHROPIC_BASE_URL':'http://127.0.0.1:1', 'EDUALC_APP_ROOT':str(ROOT),'EDUALC_VERIFY_OUTPUT_UI':'1','EDUALC_OUTPUT_MODEL_FILE':str(home/'model-log.jsonl'),
        'EDUALC_SDK_PACKAGE':str(Path('/Users/rakuto/.local/share/edualc/sdk/current/node_modules/@anthropic-ai/claude-agent-sdk')),
        'BUN_OPTIONS':'--preload='+str(SOURCE_ROOT/'scripts/verify-output-contract.mjs'),
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','DISABLE_NON_ESSENTIAL_MODEL_CALLS':'1','DISABLE_AUTOUPDATER':'1',
        'CLAUDE_CODE_MODEL_CATALOG':'off','HTTP_PROXY':'','HTTPS_PROXY':'','ALL_PROXY':'','NO_PROXY':'*'})
    terminal = Terminal(environment, ['--model','claude-opus-5','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'], 'native')
    try:
        terminal.wait('Opus 5')
        terminal.send('OUTPUT_CONTRACT_FIXTURE\r')
        terminal.wait('REPLACEMENT_OUTPUT_619283')
        terminal.wait('REFUSAL_SWITCH_573192')
        terminal.wait('CONSENT_SWITCH_823761')
        terminal.drain(.7)
        screen = '\n'.join(terminal.screen.display)
        assert 'RETRACTED_OUTPUT_719382' not in screen, screen
        assert 'TOOL_SUMMARY_INTERNAL_918273' not in screen, screen
        assert 'REFUSAL_STOP_651823' not in screen, screen
        first = [json.loads(line) for line in (home/'model-log.jsonl').read_text().splitlines()]
        assert any(row.get('type') == 'history' and not row['hasRetracted'] and row['hasReplacement'] for row in first), first
        terminal.send('SECOND_OUTPUT_CONTRACT_FIXTURE\r')
        terminal.wait('SECOND_OUTPUT_TURN_816293')
        terminal.drain(.7)
        model_log = [json.loads(line) for line in (home/'model-log.jsonl').read_text().splitlines()]
        assert all(row.get('model') != 'claude-opus-5' for row in model_log[1:] if row['type'] in ('init','setModel')), model_log
        assert all(row.get('model') == 'claude-sonnet-5' for row in model_log if row['type'] == 'history'), model_log
        checks.extend(['native transcript loader excludes superseded rows and retains replacement', 'next turn and native model selection keep the SDK session switch'])
        checks.extend(['superseded response removed by the original TUI', 'refusal-switch and consent notices rendered; no-fallback notice hidden as in the original TUI','tool summary stays hidden like the original event consumer'])
        print('PASS: '+', '.join(checks))
    finally:
        terminal.stop()
        stop_isolated_processes(home)
        ARTIFACT.with_name('output-contract-result.json').write_text(json.dumps({'checks':checks,'mode':'SDK wire fixture injected into createSdkRun; native TUI unchanged; no external API'},indent=2)+'\n')
