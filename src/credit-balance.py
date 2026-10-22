"""Bridge CodexBar's Console balance to the shared status line."""
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

TTL = 300
REFRESH_INTERVAL = 240
RETRY = 60


def read_json(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def key_identity(home):
    key = read_json(home / '.edualc/settings.json').get('env', {}).get('ANTHROPIC_API_KEY')
    if not isinstance(key, str) or not key.strip():
        return None
    return hashlib.sha256(key.encode()).hexdigest()


def api_session(home):
    path = os.environ.get('EDUALC_AUTH_SETTINGS_FILE')
    if not path or Path(path) != home / '.edualc/runtime-auth.json':
        return False
    key = read_json(Path(path)).get('env', {}).get('ANTHROPIC_API_KEY')
    return isinstance(key, str) and bool(key.strip()) and (
        hashlib.sha256(key.encode()).hexdigest() == key_identity(home))


def parse_balance(payload, organization):
    if not isinstance(payload, list) or len(payload) != 1:
        raise ValueError('Unexpected provider count')
    item = payload[0]
    if not isinstance(item, dict) or item.get('provider') != 'claudeplatform' or item.get('error'):
        raise ValueError('Console balance unavailable')
    usage = item['usage']
    if not isinstance(usage, dict) or not isinstance(usage.get('identity'), dict):
        raise ValueError('Console identity missing')
    if usage['identity'].get('accountOrganization') != organization:
        raise ValueError('Console organization does not match')
    cost = usage['providerCost']
    if not isinstance(cost, dict):
        raise ValueError('Console balance missing')
    value = cost.get('balance')
    if cost.get('currencyCode') != 'USD' or type(value) not in (int, float):
        raise ValueError('USD balance missing')
    if not math.isfinite(value) or value < 0:
        raise ValueError('Invalid balance')
    return value


def atomic_json(path, value):
    fd, pending = tempfile.mkstemp(dir=path.parent, prefix='.balance-')
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(value, handle, allow_nan=False)
        os.replace(pending, path)
    finally:
        if os.path.exists(pending):
            os.unlink(pending)


def configuration(home):
    name = read_json(home / '.edualc/balance.json').get('organization')
    return name if isinstance(name, str) and name.strip() else None


def refresh(home):
    directory = home / '.edualc'
    directory.mkdir(mode=0o700, exist_ok=True)
    with open(directory / 'balance.lock', 'a', opener=lambda p, f: os.open(p, f, 0o600)) as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        organization = configuration(home)
        identity = key_identity(home)
        result = {'attempted_at': time.time(), 'organization': organization, 'key': identity}
        try:
            if not organization or not identity:
                raise ValueError('Console organization is not configured')
            # Do not pass conversation credentials, proxy settings, or preload hooks to CodexBar.
            env = {'HOME': str(home), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
                   'LANG': 'en_US.UTF-8', 'CODEXBAR_CONFIG': str(directory / 'codexbar.json')}
            executable = home / '.local/share/edualc/tools/codexbar/0.79.0/CodexBarCLI'
            response = subprocess.run([
                str(executable), 'usage', '--provider', 'claude-platform', '--source', 'web',
                '--json', '--web-timeout', '20',
            ], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, timeout=25, check=True)
            result['balance'] = parse_balance(json.loads(response.stdout), organization)
            result['updated_at'] = time.time()
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            result['error'] = 'unavailable'
        atomic_json(directory / 'balance-cache.json', result)


def status(home):
    if not api_session(home):
        return ''
    organization = configuration(home)
    if not organization:
        return 'balance not configured'
    cache = read_json(home / '.edualc/balance-cache.json')
    matches = cache.get('organization') == organization and cache.get('key') == key_identity(home)
    now = time.time()
    attempted = cache.get('attempted_at', 0) if matches else 0
    if not isinstance(attempted, (int, float)):
        attempted = 0
    delay = RETRY if cache.get('error') else REFRESH_INTERVAL
    if not 0 <= now - attempted < delay:
        subprocess.Popen([sys.executable, '-I', '-S', str(Path(__file__).resolve()), 'refresh'],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    updated = cache.get('updated_at', 0)
    value = cache.get('balance')
    if (matches and not cache.get('error') and type(value) in (int, float)
            and math.isfinite(value) and value >= 0 and isinstance(updated, (int, float))
            and 0 <= now - updated < TTL):
        return f'${value:.2f} left'
    return 'balance unavailable'


if __name__ == '__main__':
    if sys.argv[1:] == ['refresh']:
        refresh(Path.home())
    elif sys.argv[1:] == ['status']:
        print(status(Path.home()))
    else:
        raise SystemExit('Usage: edualc-balance status|refresh')
