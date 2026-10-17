# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Capture a real terminal and its decoded screen for comparison."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import termios
import time
import pyte

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--wait', type=float, default=4)
parser.add_argument('--startup-wait', type=float)
parser.add_argument('--settle-wait', type=float, default=0, help='Keep reading after all expected output appears')
parser.add_argument('--expect-timeout', type=float, default=60)
parser.add_argument('--ready', help='Wait until this text appears before sending keys')
parser.add_argument('--keys', action='append', default=[])
parser.add_argument('--expect-after', action='append', default=[])
parser.add_argument('--columns', type=int, default=100)
parser.add_argument('--rows', type=int, default=32)
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ['--'] else args.command
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', args.rows, args.columns, 0, 0))
environment = {**os.environ, 'TERM': 'xterm-256color', 'DISABLE_AUTOUPDATER': '1'}
process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=environment, start_new_session=True)
os.close(slave)
screen = pyte.Screen(args.columns, args.rows)
stream = pyte.ByteStream(screen)
raw = bytearray()
snapshots = []

def drain(duration):
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        if not select.select([master], [], [], min(0.1, max(0, deadline-time.monotonic())))[0]:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        raw.extend(chunk)
        stream.feed(chunk)

try:
    drain(args.startup_wait if args.startup_wait is not None else args.wait)
    if args.ready:
        deadline = time.monotonic() + 45
        while args.ready not in '\n'.join(screen.display):
            if process.poll() is not None:
                raise AssertionError(f'TUI exited before becoming ready: {process.returncode}')
            if time.monotonic() >= deadline:
                raise AssertionError(f'TUI did not become ready: {args.ready}')
            drain(0.2)
    snapshots.append({'keys': None, 'screen': screen.display})
    for index, text in enumerate(args.keys):
        os.write(master, bytes(text, 'utf-8').decode('unicode_escape').encode() if text.startswith('\\') else text.encode())
        drain(args.wait)
        expected = args.expect_after[index] if index < len(args.expect_after) else ''
        if expected:
            deadline = time.monotonic() + args.expect_timeout
            while expected not in '\n'.join(screen.display):
                if process.poll() is not None:
                    raise AssertionError(f'TUI exited before expected output: {process.returncode}: {expected}')
                if time.monotonic() >= deadline:
                    raise AssertionError(f'TUI output not observed after key {index}: {expected}')
                drain(0.2)
        snapshots.append({'keys': text, 'screen': screen.display})
    drain(args.settle_wait)
    print('\n'.join(screen.display))
finally:
    snapshots.append({'keys': None, 'final': True, 'screen': list(screen.display)})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.with_suffix('.json').write_text(json.dumps(snapshots, ensure_ascii=False, indent=2)+'\n')
    args.output.with_suffix('.txt').write_text('\n'.join(screen.display)+'\n')
    args.output.with_suffix('.ansi').write_bytes(raw)
    if process.poll() is None:
        process.terminate()
        drain(2)
    if process.poll() is None:
        process.kill()
    process.wait(timeout=5)
    os.close(master)
