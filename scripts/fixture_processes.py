"""Stop only child processes belonging to a disposable test HOME."""
import os
import re
import signal
import subprocess
import time


def stop_isolated_processes(home):
    pattern = re.compile(r'(?:^|\s)HOME=' + re.escape(str(home)) + r'(?:\s|$)')

    def running():
        output = subprocess.run(['ps', 'axeww', '-o', 'pid=,command='],
                                check=True, text=True, capture_output=True).stdout
        return [int(row.split(None, 1)[0]) for row in output.splitlines()
                if pattern.search(row) and int(row.split(None, 1)[0]) != os.getpid()]

    for termination in [signal.SIGTERM, signal.SIGKILL]:
        for pid in running():
            try:
                os.kill(pid, termination)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 3
        while running() and time.monotonic() < deadline:
            time.sleep(.1)
    remaining = running()
    if remaining:
        raise AssertionError(f'Isolated fixture processes remain: {remaining}')
