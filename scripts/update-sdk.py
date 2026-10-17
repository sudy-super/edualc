#!/usr/bin/env python3
"""Install and verify the latest SDK before atomically selecting it for future runs."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
STORE = (Path.home() / '.local/share/edualc/sdk').resolve()
PACKAGE = '@anthropic-ai/claude-agent-sdk'


def run(arguments, **kwargs):
    return subprocess.run(arguments, check=True, text=True, timeout=300, **kwargs)


def update():
    STORE.mkdir(parents=True, exist_ok=True)
    with (STORE / 'update.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('SDK 更新処理は既に実行中です。')
            return
        version = json.loads(run(['npm', 'view', PACKAGE, 'version', '--json'], capture_output=True).stdout)
        if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', version):
            raise ValueError(f'安定版のバージョン番号ではありません: {version!r}')
        target = STORE / 'versions' / version
        current = STORE / 'current'
        verifier_hash = hashlib.sha256((ROOT / 'scripts/check-sdk-update.mjs').read_bytes() + (ROOT / 'src/sdk.ts').read_bytes()).hexdigest()
        active = current.is_symlink() and current.resolve() == target
        verification_path = target / 'verified.json'
        if active and verification_path.is_file() and json.loads(verification_path.read_text()).get('verifierSha256') == verifier_hash:
            print(f'Claude Agent SDK {version}: 最新版です。')
            return
        target.mkdir(parents=True, exist_ok=True)
        if not active:
            run(['npm', 'install', '--prefix', str(target), '--omit=dev', '--include=optional',
                 '--ignore-scripts', '--no-audit', '--no-fund', f'{PACKAGE}@{version}'])
        sdk = target / 'node_modules' / PACKAGE
        metadata = json.loads((sdk / 'package.json').read_text())
        if metadata['version'] != version:
            raise ValueError('インストールした SDK のバージョンが一致しません。')
        machine = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'AMD64': 'x64'}[platform.machine()]
        system = {'darwin': 'darwin', 'linux': 'linux'}[sys.platform]
        native = sdk.parent / f'claude-agent-sdk-{system}-{machine}' / 'claude'
        manifest = json.loads((sdk / 'manifest.json').read_text())
        if manifest['version'] != metadata['claudeCodeVersion']:
            raise ValueError('SDK と内蔵 CLI のバージョン情報が一致しません。')
        if hashlib.sha256(native.read_bytes()).hexdigest() != manifest['platforms'][f'{system}-{machine}']['checksum']:
            raise ValueError('SDK 対応実行ファイルの SHA-256 が一致しません。')
        tui_binary = json.loads((ROOT / 'vendor/claude-full/manifest.json').read_text())['binary']
        environment = {**os.environ, 'BUN_OPTIONS': f'--preload={ROOT / "scripts/check-sdk-update.mjs"}',
                       'EDUALC_SDK_PACKAGE': str(sdk)}
        result = run([tui_binary, str(sdk), str(native)], env=environment, capture_output=True)
        print(result.stdout.strip())
        verification = json.loads(result.stdout)
        if verification.get('pass') is not True:
            raise ValueError('SDK の互換性検証に成功していません。')
        record = {'sdk': version, 'claudeCode': metadata['claudeCodeVersion'], 'verifierSha256': verifier_hash,
                  'verifiedAt': datetime.now(timezone.utc).isoformat(), **verification}
        (target / 'verified.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
        pending = STORE / f'.current-{os.getpid()}'
        pending.symlink_to(target)
        pending.replace(current)
        print(f'Claude Agent SDK {version} に更新しました。次回起動から適用します。')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        update()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f'SDK の更新に失敗しました。使用中の版は変更していません: {error}', file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
